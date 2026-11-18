"""
yanz-worker: layanan kecil yang berjalan di mesin sendiri (mis. Instabox) dan mengerjakan
tugas yang tidak bisa dijalankan di Vercel: tangkapan layar situs, PDF, ffmpeg, hapus latar,
OCR, suara ke teks, dan teks ke suara.

Semua rute /v1/* butuh header `x-worker-key`. Rute /f/<nama> (berkas hasil, nama acak)
dan /health terbuka. Parameter dikirim lewat query string; berkas masukan lewat `url`
atau sebagai isi permintaan (POST, isi mentah).
"""

import asyncio
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp import web

VERSION = "1.2.0"
ROOT = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    """Baca worker/.env bila dijalankan langsung tanpa Docker."""
    if not path.is_file():
        return
    for raw in path.read_text("utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and v and k not in os.environ:
            os.environ[k] = v


_load_dotenv(ROOT / ".env")


def _env(name: str, default: str) -> str:
    v = os.environ.get(name, "").strip()
    return v if v else default


_MODELS_BASE = Path("/models") if Path("/models").is_dir() else ROOT / ".models"
os.environ.setdefault("REMBG_HOME", str(_MODELS_BASE / "rembg"))
os.environ.setdefault("U2NET_HOME", str(_MODELS_BASE / "rembg"))
os.environ.setdefault("HF_HOME", str(_MODELS_BASE / "hf"))
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/browsers" if Path("/opt/browsers").is_dir() else str(ROOT / ".browsers"))

_DEFAULT_DATA = "/data" if Path("/data").is_dir() and os.access("/data", os.W_OK) else str(ROOT / ".data")

KEY = _env("WORKER_KEY", "")
PORT = int(_env("PORT", "8080"))
DATA = Path(_env("DATA_DIR", _DEFAULT_DATA))
OUT = DATA / "out"
FILE_TTL = int(_env("FILE_TTL_SEC", "3600"))
MAX_INPUT = int(_env("MAX_INPUT_MB", "50")) * 1024 * 1024
MAX_JOBS = int(_env("MAX_JOBS", "2"))
MAX_QUEUE = int(_env("MAX_QUEUE", "6"))
JOB_TIMEOUT = int(_env("JOB_TIMEOUT_SEC", "100"))
MAX_MEDIA_SEC = int(_env("MAX_MEDIA_SEC", "600"))
MAX_SPEECH_SEC = int(_env("MAX_SPEECH_SEC", "180"))
WHISPER_MODEL = _env("WHISPER_MODEL", "small")
REMBG_MODEL = _env("REMBG_MODEL", "u2net")
TTS_DIR = Path(_env("TTS_DIR", str(_MODELS_BASE / "tts")))
CHROMIUM = _env("CHROMIUM_PATH", "")
FFMPEG = _env("FFMPEG_PATH", "ffmpeg")
# Hanya untuk pengujian lokal: izinkan alamat internal (127.0.0.1 dan sejenisnya).
ALLOW_PRIVATE = _env("ALLOW_PRIVATE", "") == "1"

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


class Fail(Exception):
    """Galat yang pesannya aman ditampilkan ke pemanggil."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def jres(status: int, body: dict) -> web.Response:
    return web.json_response(body, status=status, headers={"cache-control": "no-store"})


# ---------------------------------------------------------------------------
# Antrean: pekerjaan berat dibatasi MAX_JOBS sekaligus, sisanya menunggu.
# ---------------------------------------------------------------------------
_slots = asyncio.Semaphore(MAX_JOBS)
_waiting = 0
_stats = {"done": 0, "failed": 0, "started": time.time()}


class Slot:
    async def __aenter__(self):
        global _waiting
        if _waiting >= MAX_QUEUE:
            raise Fail(503, "Server pengolah sedang penuh. Coba lagi beberapa saat lagi.")
        _waiting += 1
        try:
            await _slots.acquire()
        finally:
            _waiting -= 1

    async def __aexit__(self, *exc):
        _slots.release()


# ---------------------------------------------------------------------------
# Pengaman alamat: tolak alamat internal (SSRF), termasuk setelah pengalihan.
# ---------------------------------------------------------------------------
def ip_blocked(ip: str) -> bool:
    if ALLOW_PRIVATE:
        return False
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return True
    if getattr(a, "ipv4_mapped", None):
        a = a.ipv4_mapped
    return not a.is_global or a.is_multicast


async def resolve_public(host: str) -> list[str]:
    """Alamat IP publik untuk host. Fail bila host mengarah ke alamat internal."""
    host = host.strip("[]")
    try:
        ipaddress.ip_address(host)
        ips = [host]
    except ValueError:
        loop = asyncio.get_running_loop()
        try:
            infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except OSError:
            raise Fail(400, "Alamat tidak ditemukan. Periksa lagi tautannya.")
        ips = list(dict.fromkeys(i[4][0] for i in infos))
    if not ips or any(ip_blocked(ip) for ip in ips):
        raise Fail(400, "Alamat itu tidak diizinkan.")
    return ips


def check_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise Fail(400, "Parameter 'url' wajib diisi.")
    if len(raw) > 2000:
        raise Fail(400, "Tautan terlalu panjang.")
    if re.match(r"^[a-z][a-z0-9+.-]*:", raw, re.I) and not re.match(r"^https?://", raw, re.I) and not re.match(r"^[^/:]+:\d+(/|$)", raw):
        raise Fail(400, "Hanya tautan http atau https yang didukung.")
    if not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    u = urlsplit(raw)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise Fail(400, "Hanya tautan http atau https yang didukung.")
    if u.username or u.password:
        raise Fail(400, "Tautan dengan nama pengguna atau kata sandi tidak didukung.")
    return raw


class PinnedResolver(aiohttp.abc.AbstractResolver):
    """Resolver yang hanya mengembalikan alamat yang sudah diperiksa, supaya koneksi tidak bisa dialihkan lewat DNS."""

    def __init__(self, host: str, ips: list[str]):
        self.host = host
        self.ips = ips

    async def resolve(self, host, port=0, family=socket.AF_INET):
        if host.lower() != self.host.lower():
            raise OSError("host tidak dikenal")
        out = []
        for ip in self.ips:
            fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
            if family not in (0, socket.AF_UNSPEC) and fam != family:
                continue
            out.append({"hostname": host, "host": ip, "port": port, "family": fam, "proto": 0, "flags": socket.AI_NUMERICHOST})
        if not out:
            raise OSError("alamat IP untuk keluarga soket itu tidak tersedia")
        return out

    async def close(self):
        return None


async def download(raw: str, dest: Path, max_bytes: int, what: str = "Berkas") -> str:
    """Unduh tautan publik ke `dest`. Mengembalikan content-type. Pengalihan diikuti satu per satu dan diperiksa ulang."""
    url = check_url(raw)
    for _ in range(6):
        u = urlsplit(url)
        ips = await resolve_public(u.hostname)
        conn = aiohttp.TCPConnector(resolver=PinnedResolver(u.hostname, ips), ttl_dns_cache=None, use_dns_cache=False)
        timeout = aiohttp.ClientTimeout(total=45, connect=10)
        try:
            async with aiohttp.ClientSession(connector=conn, timeout=timeout, headers={"user-agent": UA, "accept": "*/*"}) as s:
                async with s.get(url, allow_redirects=False) as r:
                    if r.status in (301, 302, 303, 307, 308):
                        loc = r.headers.get("location")
                        if not loc:
                            raise Fail(502, f"{what} tidak bisa diunduh dari tautan itu.")
                        url = check_url(urljoin(url, loc))
                        continue
                    if r.status != 200:
                        raise Fail(400, f"{what} tidak bisa diunduh dari tautan itu (status {r.status}).")
                    if int(r.headers.get("content-length") or 0) > max_bytes:
                        raise Fail(413, f"{what} terlalu besar (maks {max_bytes // 1024 // 1024} MB).")
                    total = 0
                    with dest.open("wb") as f:
                        async for chunk in r.content.iter_chunked(64 * 1024):
                            total += len(chunk)
                            if total > max_bytes:
                                raise Fail(413, f"{what} terlalu besar (maks {max_bytes // 1024 // 1024} MB).")
                            f.write(chunk)
                    if total == 0:
                        raise Fail(400, f"{what} di tautan itu kosong.")
                    return (r.headers.get("content-type") or "").split(";")[0].strip().lower()
        except Fail:
            raise
        except asyncio.TimeoutError:
            raise Fail(504, f"{what} terlalu lama diunduh dari tautan itu.")
        except (aiohttp.ClientError, OSError):
            raise Fail(502, f"{what} tidak bisa diunduh dari tautan itu.")
    raise Fail(400, "Tautan itu mengalihkan terlalu banyak kali.")


async def take_input(request: web.Request, work: Path, max_bytes: int, what: str = "Berkas") -> Path:
    """Berkas masukan: isi permintaan (unggahan) atau parameter `url`."""
    dest = work / "in"
    if request.can_read_body:
        total = 0
        with dest.open("wb") as f:
            async for chunk in request.content.iter_chunked(64 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise Fail(413, f"{what} terlalu besar (maks {max_bytes // 1024 // 1024} MB).")
                f.write(chunk)
        if total:
            return dest
    url = request.query.get("url", "")
    if not url:
        raise Fail(400, "Tidak ada berkas yang dikirim. Isi parameter 'url' atau unggah berkasnya.")
    await download(url, dest, max_bytes, what)
    return dest


# ---------------------------------------------------------------------------
# Alat bantu
# ---------------------------------------------------------------------------
def qint(request: web.Request, name: str, default: int, lo: int, hi: int) -> int:
    raw = request.query.get(name, "")
    if raw == "":
        return default
    try:
        return max(lo, min(hi, int(float(raw))))
    except ValueError:
        raise Fail(400, f"Parameter '{name}' harus berupa angka.")


def qfloat(request: web.Request, name: str, default: float, lo: float, hi: float) -> float:
    raw = request.query.get(name, "")
    if raw == "":
        return default
    try:
        v = float(raw)
    except ValueError:
        raise Fail(400, f"Parameter '{name}' harus berupa angka.")
    if v != v:
        raise Fail(400, f"Parameter '{name}' harus berupa angka.")
    return max(lo, min(hi, v))


def qpick(request: web.Request, name: str, options: list[str], default: str) -> str:
    v = request.query.get(name, "").strip().lower()
    if not v:
        return default
    if v not in options:
        raise Fail(400, f"Parameter '{name}' harus salah satu dari: {', '.join(options)}.")
    return v


async def run(cmd: list[str], timeout: float, cwd: Path | None = None) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=str(cwd) if cwd else None
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise Fail(504, "Pengolahan terlalu lama dan dihentikan. Coba berkas yang lebih pendek atau lebih kecil.")
    return proc.returncode or 0, out, err


async def probe(path: Path) -> dict:
    """Durasi dan jenis stream berkas media, dibaca dari keluaran `ffmpeg -i`."""
    _, _, err = await run([FFMPEG, "-hide_banner", "-i", str(path)], 30)
    text = err.decode("utf-8", "replace")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0
    video = re.search(r"Stream #\S+.*Video:\s*(\w+)", text)
    audio = bool(re.search(r"Stream #\S+.*Audio:", text))
    # Gambar diam: codec gambar, atau tanpa durasi dan tanpa suara.
    still = bool(video) and not audio and (video.group(1).lower() in ("mjpeg", "png", "bmp", "tiff", "webp") or duration == 0)
    size = re.search(r"Video:.*?\b(\d{2,5})x(\d{2,5})\b", text)
    return {
        "duration": duration,
        "video": bool(video),
        "audio": audio,
        "still": still,
        "width": int(size.group(1)) if size else 0,
        "height": int(size.group(2)) if size else 0,
        "known": "Invalid data found" not in text and bool(re.search(r"Stream #", text)),
    }


def need_media(info: dict, video: bool = False, audio: bool = False, max_sec: int = 0) -> None:
    if not info["known"]:
        raise Fail(400, "Berkas itu bukan video, audio, atau gambar yang bisa dibaca.")
    if video and (not info["video"] or info["still"]):
        raise Fail(400, "Berkas itu tidak berisi video.")
    if audio and not info["audio"]:
        raise Fail(400, "Berkas itu tidak berisi suara.")
    if max_sec and info["duration"] > max_sec:
        raise Fail(400, f"Durasi berkas {int(info['duration'])} detik, melebihi batas {max_sec} detik.")


async def ffmpeg(args: list[str], out: Path, timeout: float = JOB_TIMEOUT) -> None:
    code, _, err = await run([FFMPEG, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", *args, str(out)], timeout)
    if code != 0 or not out.exists() or out.stat().st_size == 0:
        print("[ffmpeg]", err.decode("utf-8", "replace")[-600:], file=sys.stderr, flush=True)
        raise Fail(422, "Berkas itu tidak bisa diolah. Coba berkas lain atau format lain.")


TYPES = {
    "mp3": "audio/mpeg", "ogg": "audio/ogg", "wav": "audio/wav", "m4a": "audio/mp4", "mp4": "video/mp4",
    "gif": "image/gif", "webp": "image/webp", "png": "image/png", "jpg": "image/jpeg", "pdf": "application/pdf",
}


def publish(path: Path, ext: str) -> dict:
    """Pindahkan berkas hasil ke folder publik dengan nama acak. Dihapus otomatis setelah FILE_TTL."""
    name = f"{secrets.token_urlsafe(18)}.{ext}"
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), OUT / name)
    size = (OUT / name).stat().st_size
    return {"file": name, "type": TYPES[ext], "size": size, "expires_in": FILE_TTL}


# ---------------------------------------------------------------------------
# Chromium: satu browser dipakai bersama, satu konteks baru per permintaan.
# ---------------------------------------------------------------------------
_browser = None
_playwright = None
_browser_lock = asyncio.Lock()

DEVICES = {
    "desktop": {"viewport": {"width": 1366, "height": 768}, "device_scale_factor": 1, "is_mobile": False, "user_agent": UA},
    "tablet": {
        "viewport": {"width": 820, "height": 1180}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True,
        "user_agent": "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    },
    "mobile": {
        "viewport": {"width": 390, "height": 844}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True,
        "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    },
}


async def browser():
    global _browser, _playwright
    async with _browser_lock:
        if _browser and _browser.is_connected():
            return _browser
        from playwright.async_api import async_playwright

        if _playwright is None:
            _playwright = await async_playwright().start()
        # Sebagian mesin cloud (VPS NAT/LXC) punya variabel proxy di lingkungan root yang tidak
        # valid; Chromium lalu mengira tidak ada jaringan (ERR_INTERNET_DISCONNECTED). Proxy
        # dibuang dari lingkungan proses dan pemakaian proxy dimatikan.
        clean_env = {k: v for k, v in os.environ.items() if "proxy" not in k.lower()}
        opts = {
            "args": [
                "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
                "--hide-scrollbars", "--mute-audio", "--no-proxy-server", "--disable-background-networking",
                "--disable-features=NetworkServiceSandbox", "--dns-prefetch-disable", "--no-first-run",
                # Sebagian jaringan VPS memutus HTTP/2; HTTP/1.1 lebih stabil untuk keluar.
                "--disable-http2",
            ],
            "env": clean_env,
        }
        sys_bin = CHROMIUM or shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
        has_bundled = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")).is_dir() and any(Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"]).glob("chromium*"))
        if CHROMIUM:
            opts["executable_path"] = CHROMIUM
        elif sys_bin and not has_bundled:
            opts["executable_path"] = sys_bin
        try:
            _browser = await _playwright.chromium.launch(**opts)
        except Exception:
            if "executable_path" in opts or not sys_bin:
                raise
            opts["executable_path"] = sys_bin
            _browser = await _playwright.chromium.launch(**opts)
        return _browser


async def open_page(url: str, device: str, wait_ms: int, dark: bool):
    """Buka halaman dengan penjaga: setiap permintaan dari halaman itu diperiksa agar tidak menyentuh alamat internal."""
    b = await browser()
    ctx = await b.new_context(**DEVICES[device], locale="id-ID", color_scheme="dark" if dark else "light", service_workers="block", accept_downloads=False)
    seen: dict[str, bool] = {}

    async def guard(route):
        try:
            u = urlsplit(route.request.url)
            if u.scheme in ("data", "blob", "about"):
                return await route.continue_()
            if u.scheme not in ("http", "https") or not u.hostname:
                return await route.abort("blockedbyclient")
            ok = seen.get(u.hostname)
            if ok is None:
                try:
                    await resolve_public(u.hostname)
                    ok = True
                except Fail:
                    ok = False
                seen[u.hostname] = ok
            if not ok:
                return await route.abort("blockedbyclient")
            await route.continue_()
        except Exception:
            try:
                await route.abort()
            except Exception:
                pass

    await ctx.route("**/*", guard)
    page = await ctx.new_page()
    page.on("dialog", lambda d: asyncio.ensure_future(d.dismiss()))
    try:
        from playwright.async_api import Error as PwError, TimeoutError as PwTimeout

        async def fetch():
            try:
                return await page.goto(url, wait_until="load", timeout=30000)
            except PwTimeout:
                # Halaman berat sering tidak pernah mencapai "load": cukup bila isinya sudah ada.
                if page.url in ("about:blank", ""):
                    raise Fail(504, "Halaman itu terlalu lama dimuat.")
                return None

        try:
            res = await fetch()
        except PwError as first_err:
            # Galat jaringan sesaat (DNS belum siap tepat setelah boot, rute keluar baru aktif)
            # sering lolos pada percobaan kedua. Hanya galat jaringan yang diulang.
            transient = any(
                k in str(first_err)
                for k in ("ERR_CONNECTION", "ERR_TIMED_OUT", "ERR_NAME_NOT_RESOLVED", "ERR_ADDRESS_UNREACHABLE", "ERR_INTERNET_DISCONNECTED")
            )
            if not transient:
                msg = str(first_err)
                code = ""
                m = re.search(r"net::(ERR_[A-Z_]+)", msg)
                if m:
                    code = m.group(1)
                print(f"[halaman] {msg.splitlines()[0][:200]}", file=sys.stderr, flush=True)
                if "ERR_CERT" in msg or "ERR_SSL" in msg:
                    raise Fail(502, "Sertifikat keamanan halaman itu bermasalah, jadi tidak bisa dibuka.")
                if code == "ERR_TOO_MANY_REDIRECTS":
                    raise Fail(502, "Situs itu mengalihkan terlalu banyak kali sebelum halamannya terbuka.")
                if code in ("ERR_BLOCKED_BY_CLIENT", "ERR_BLOCKED_BY_RESPONSE"):
                    raise Fail(400, "Alamat itu tidak diizinkan atau menolak koneksi dari server worker.")
                if code == "ERR_ABORTED":
                    raise Fail(504, "Halaman itu membatalkan pemuatan sebelum selesai. Coba lagi.")
                raise Fail(502, f"Halaman itu tidak bisa dibuka{': ' + code if code else ''}.")
            await page.wait_for_timeout(1500)
            try:
                res = await fetch()
            except PwError as e:
                code = ""
                m = re.search(r"net::(ERR_[A-Z_]+)", str(e))
                if m:
                    code = m.group(1)
                print(f"[halaman] {str(e).splitlines()[0][:200]}", file=sys.stderr, flush=True)
                if code in ("ERR_NAME_NOT_RESOLVED", "ERR_NAME_RESOLUTION_FAILED"):
                    raise Fail(400, "Alamat tidak ditemukan. Periksa lagi tautannya.")
                if code in (
                    "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED",
                    "ERR_CONNECTION_TIMED_OUT", "ERR_TIMED_OUT", "ERR_ADDRESS_UNREACHABLE",
                    "ERR_INTERNET_DISCONNECTED", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_PROXY_CONNECTION_FAILED",
                ):
                    raise Fail(502, f"Situs itu tidak merespons dari server worker ({code}).")
                raise Fail(502, f"Halaman itu tidak bisa dibuka{': ' + code if code else ''}.")
        if wait_ms:
            await page.wait_for_timeout(wait_ms)
        return ctx, page, (res.status if res else 0)
    except BaseException:
        await ctx.close()
        raise


async def ssweb(request: web.Request, work: Path) -> web.Response:
    url = check_url(request.query.get("url", ""))
    await resolve_public(urlsplit(url).hostname)
    device = qpick(request, "device", list(DEVICES), "desktop")
    full = request.query.get("full", "") in ("1", "true", "ya")
    fmt = qpick(request, "format", ["png", "jpg"], "png")
    wait_ms = qint(request, "wait", 0, 0, 10) * 1000
    dark = request.query.get("dark", "") in ("1", "true", "ya")
    ctx, page, status = await open_page(url, device, wait_ms, dark)
    try:
        if full:
            # Halaman yang sangat panjang dipotong supaya gambar tidak melebihi batas ukuran.
            height = await page.evaluate("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")
            limit = 12000
            if height > limit:
                vp = DEVICES[device]["viewport"]
                await page.set_viewport_size({"width": vp["width"], "height": limit})
                full = False
        kw = {"type": "jpeg", "quality": 82} if fmt == "jpg" else {"type": "png"}
        data = await page.screenshot(full_page=full, timeout=30000, **kw)
        if fmt == "png" and len(data) > 4 * 1024 * 1024:
            # Di atas 4 MB tidak muat lewat Vercel; kirim sebagai JPG.
            data = await page.screenshot(full_page=full, timeout=30000, type="jpeg", quality=80)
            fmt = "jpg"
        if len(data) > 4 * 1024 * 1024:
            data = await page.screenshot(full_page=False, timeout=30000, type="jpeg", quality=75)
    finally:
        await ctx.close()
    return web.Response(body=data, content_type=TYPES[fmt], headers={"cache-control": "no-store", "x-page-status": str(status)})


async def web2pdf(request: web.Request, work: Path) -> web.Response:
    url = check_url(request.query.get("url", ""))
    await resolve_public(urlsplit(url).hostname)
    paper = qpick(request, "paper", ["a4", "letter", "legal", "a3"], "a4")
    landscape = request.query.get("landscape", "") in ("1", "true", "ya")
    wait_ms = qint(request, "wait", 0, 0, 10) * 1000
    ctx, page, status = await open_page(url, "desktop", wait_ms, False)
    try:
        title = (await page.title())[:200]
        out = work / "out.pdf"
        await page.pdf(path=str(out), format=paper.upper() if paper in ("a4", "a3") else paper.capitalize(), landscape=landscape, print_background=True, margin={"top": "12mm", "bottom": "12mm", "left": "10mm", "right": "10mm"})
    finally:
        await ctx.close()
    return jres(200, {**publish(out, "pdf"), "title": title, "page_status": status})


# ---------------------------------------------------------------------------
# Turnstile: tembus verifikasi Cloudflare di halaman yang kamu kelola sendiri.
# ---------------------------------------------------------------------------
# Dua cara: klik kotak "Verify you are human" seperti pengunjung biasa, atau pakai kunci
# layanan pemecah captcha (2captcha). Pemakaian hanya untuk situs milik sendiri: endpoint
# di API hanya dibuka untuk paket berbayar dan setiap pemakaian tercatat atas nama API key.
TURNSTILE_SEL = [
    "iframe[src*='challenges.cloudflare.com']",
    "#cf-turnstile",
    ".cf-turnstile",
    "input[name='cf-turnstile-response']",
]
# Tanda halaman sudah lolos, bukan lagi menampilkan tantangan.
TURNSTILE_DONE = [
    "input[name='cf-turnstile-response']",
    "textarea[name='cf-turnstile-response']",
]


async def _turnstile_present(page) -> bool:
    for sel in TURNSTILE_SEL:
        try:
            if await page.locator(sel).count():
                return True
        except Exception:
            continue
    html = await page.content()
    return "challenges.cloudflare.com" in html or "cf-turnstile" in html


async def _turnstile_token(page) -> str:
    for sel in TURNSTILE_DONE:
        try:
            val = await page.locator(sel).first().input_value(timeout=1500)
            if val:
                return val
        except Exception:
            continue
    return ""


def turnstile_target(request: web.Request) -> tuple[str, str, int]:
    """URL dan lama tunggu; tanpa membuka browser (dipakai juga oleh /v1/diag)."""
    url = check_url(request.query.get("url", ""))
    return url, (urlsplit(url).hostname or ""), qint(request, "wait", 20, 3, 45) * 1000


async def diag(request: web.Request, work: Path) -> web.Response:
    """Cek jalur keluar worker ke satu alamat: DNS, HTTP langsung, lalu Chromium."""
    url = check_url(request.query.get("url", ""))
    host = urlsplit(url).hostname or ""
    out: dict = {"url": url, "host": host, "steps": {}}
    try:
        out["steps"]["dns"] = {"ok": True, "ips": (await resolve_public(host))[:3]}
    except Fail as e:
        out["steps"]["dns"] = {"ok": False, "error": e.message}
        return jres(400, out)
    # HTTP biasa (aiohttp) dulu: memisahkan masalah jaringan dari masalah Chromium.
    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, allow_redirects=True) as r:
                out["steps"]["http"] = {"ok": True, "status": r.status, "final_url": str(r.url)}
    except Exception as e:  # noqa: BLE001
        out["steps"]["http"] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    # Chromium: laporkan kode galat net::ERR_* apa adanya untuk menelusuri penyebabnya.
    try:
        ctx, page, status = await open_page(url, "desktop", 0, False)
        try:
            out["steps"]["chromium"] = {
                "ok": True, "status": status, "url": page.url,
                "title": (await page.title())[:120],
                "turnstile": await _turnstile_present(page),
            }
        finally:
            await ctx.close()
    except Fail as e:
        out["steps"]["chromium"] = {"ok": False, "status": e.status, "error": e.message}
    except Exception as e:  # noqa: BLE001
        out["steps"]["chromium"] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    ok = all(bool(v.get("ok")) for v in out["steps"].values())
    out["ok"] = ok
    return jres(200 if ok else 502, out)


async def _turnstile_lib(page, kind: str) -> tuple[bool, str]:
    """Coba lewat pustaka playwright-captcha (bila terpasang). Mengembalikan (selesai, catatan)."""
    try:
        from playwright_captcha import CaptchaType, ClickSolver, FrameworkType
    except Exception as e:  # noqa: BLE001
        return False, f"playwright-captcha tidak tersedia ({type(e).__name__})"
    ctype = CaptchaType.RECAPTCHA_V2 if kind == "recaptcha" else CaptchaType.CLOUDFLARE_TURNSTILE
    try:
        async with ClickSolver(framework=FrameworkType.PLAYWRIGHT, page=page) as solver:
            await solver.solve_captcha(captcha_container=page, captcha_type=ctype)
        return True, "diselesaikan lewat playwright-captcha"
    except Exception as e:  # noqa: BLE001
        return False, f"playwright-captcha gagal: {type(e).__name__}: {e}"[:200]


def _custom_sel(value: str) -> str | None:
    """Selektor kotak verifikasi khusus situsmu, mis. #cf-turnstile atau .g-recaptcha."""
    v = (value or "").strip()
    if not v or len(v) > 120:
        return None
    if not re.fullmatch(r"[#.\[\]a-zA-Z0-9_\-=:'\"\s>+~*()]+", v):
        return None
    return v


async def turnstile(request: web.Request, work: Path) -> web.Response:
    url, host, wait_ms = turnstile_target(request)
    await resolve_public(host)
    selector = _custom_sel(request.query.get("selector", ""))
    mode = qpick(request, "mode", ["auto", "klik", "library"], "auto")
    ctx, page, status = await open_page(url, "desktop", 1500, False)
    try:
        detected = await _turnstile_present(page)
        kind = "none"
        if detected:
            kind = "recaptcha" if await page.locator(".g-recaptcha, iframe[src*='recaptcha']").count() else "turnstile"
        clicked = False
        solved = False
        note = ""

        # 1) Pustaka playwright-captcha (tidak terlihat di sini) bila tersedia.
        if mode in ("auto", "library") and detected:
            solved, note = await _turnstile_lib(page, kind)
            clicked = solved

        # 2) Cara klik: klik kotak verifikasi seperti pengunjung biasa.
        if not solved and mode in ("auto", "klik"):
            targets = ([selector] if selector else []) + [
                "iframe[src*='challenges.cloudflare.com']",
                "#cf-turnstile",
                ".cf-turnstile",
            ] + (["#g-recaptcha", ".g-recaptcha"] if kind == "recaptcha" else [])
            for sel in targets:
                try:
                    box = page.locator(sel).first()
                    if not await box.count():
                        continue
                    await box.scroll_into_view_if_needed(timeout=2000)
                    await box.click(timeout=3000, position={"x": 28, "y": 28})
                    clicked = True
                    break
                except Exception:
                    continue
            deadline = time.time() + wait_ms / 1000
            while time.time() < deadline:
                await page.wait_for_timeout(1000)
                still = await _turnstile_present(page)
                token = await _turnstile_token(page)
                if token or not still:
                    solved = True
                    break

        token = await _turnstile_token(page)
        title = (await page.title())[:200]
        final_url = page.url
        text = await page.evaluate("document.body ? document.body.innerText.slice(0, 400) : ''")
        if not solved and not note:
            note = (
                "Tantangan tidak selesai. Situs itu mungkin memakai pemeriksaan tambahan (skor bot atau proteksi "
                "interaktif) yang tidak bisa dilewati dari server ini. Coba mode=klik dengan selector kotak verifikasi "
                "situsmu, atau pasang playwright-captcha di worker."
            )
        return jres(200 if solved else 422, {
            "url": final_url,
            "host": host,
            "page_status": status,
            "title": title,
            "kind": kind,
            "mode": mode,
            "selector": selector,
            "clicked": clicked,
            "solved": solved,
            "token": token or None,
            "note": None if solved else note,
            "text": text,
        })
    finally:
        await ctx.close()


# ---------------------------------------------------------------------------
# ffmpeg
# ---------------------------------------------------------------------------
async def tomp3(request: web.Request, work: Path) -> web.Response:
    src = await take_input(request, work, MAX_INPUT, "Berkas media")
    info = await probe(src)
    need_media(info, audio=True, max_sec=MAX_MEDIA_SEC)
    bitrate = qpick(request, "bitrate", ["96", "128", "192", "256", "320"], "128")
    fmt = qpick(request, "format", ["mp3", "ogg", "m4a"], "mp3")
    out = work / f"out.{fmt}"
    if fmt == "mp3":
        codec = ["-c:a", "libmp3lame", "-b:a", f"{bitrate}k"]
    elif fmt == "ogg":
        # Opus mono: format pesan suara WhatsApp.
        codec = ["-c:a", "libopus", "-b:a", "48k", "-ac", "1", "-ar", "48000"]
    else:
        codec = ["-c:a", "aac", "-b:a", f"{bitrate}k"]
    await ffmpeg(["-i", str(src), "-vn", "-map_metadata", "-1", *codec], out)
    return jres(200, {**publish(out, fmt), "duration": round(info["duration"], 2)})


async def togif(request: web.Request, work: Path) -> web.Response:
    src = await take_input(request, work, MAX_INPUT, "Video")
    info = await probe(src)
    need_media(info, video=True)
    start = qfloat(request, "start", 0, 0, 36000)
    length = qfloat(request, "duration", 6, 0.5, 15)
    width = qint(request, "width", 360, 120, 640)
    fps = qint(request, "fps", 12, 5, 20)
    if info["duration"] and start >= info["duration"]:
        raise Fail(400, f"Parameter 'start' melebihi durasi video ({int(info['duration'])} detik).")
    out = work / "out.gif"
    vf = f"fps={fps},scale={width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4"
    await ffmpeg(["-ss", str(start), "-t", str(length), "-i", str(src), "-an", "-filter_complex", vf], out)
    return jres(200, {**publish(out, "gif"), "duration": round(min(length, max(0.0, info["duration"] - start)) if info["duration"] else length, 2), "width": width})


async def compress(request: web.Request, work: Path) -> web.Response:
    """Perkecil berkas media: gambar (JPG/WebP) atau video (MP4)."""
    src = await take_input(request, work, MAX_INPUT, "Gambar atau video")
    info = await probe(src)
    need_media(info, max_sec=min(MAX_MEDIA_SEC, 300))
    quality = qpick(request, "quality", ["low", "medium", "high"], "medium")
    before = src.stat().st_size

    if info["still"]:
        # Gambar diam: batasi sisi terpanjang, lalu pilih mutu sesuai permintaan.
        fmt = qpick(request, "format", ["jpg", "webp"], "jpg")
        max_side, q = {"low": (1280, 70), "medium": (1600, 80), "high": (2560, 90)}[quality]
        out = work / f"out.{fmt}"
        scale = f"scale='min({max_side},iw)':'min({max_side},ih)':force_original_aspect_ratio=decrease:flags=lanczos"
        codec = ["-c:v", "libwebp", "-quality", str(q)] if fmt == "webp" else ["-c:v", "mjpeg", "-q:v", str(max(2, (100 - q) // 5))]
        await ffmpeg(["-i", str(src), "-frames:v", "1", "-vf", scale, *codec, "-map_metadata", "-1"], out)
        res = publish(out, fmt)
        width, height = info["width"], info["height"]
        return jres(200, {**res, "kind": "image", "width": width, "height": height, "max_side": max_side,
                          "size_before": before, "saved_percent": max(0, round((1 - res["size"] / before) * 100)) if before else 0})

    need_media(info, video=True)
    crf, max_h, abr = {"low": (32, 480, "64k"), "medium": (28, 720, "96k"), "high": (24, 1080, "128k")}[quality]
    out = work / "out.mp4"
    vf = f"scale=-2:'min({max_h},ih)':flags=bicubic,format=yuv420p"
    args = ["-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-vf", vf,
            "-c:a", "aac", "-b:a", abr, "-movflags", "+faststart", "-map_metadata", "-1", "-threads", "2"]
    await ffmpeg(args, out)
    res = publish(out, "mp4")
    return jres(200, {**res, "kind": "video", "duration": round(info["duration"], 2), "max_height": max_h,
                      "size_before": before, "saved_percent": max(0, round((1 - res["size"] / before) * 100)) if before else 0})


async def sticker(request: web.Request, work: Path) -> web.Response:
    """Stiker WhatsApp: WebP 512x512, latar transparan; video dan GIF jadi stiker bergerak."""
    src = await take_input(request, work, min(MAX_INPUT, 20 * 1024 * 1024), "Gambar atau video")
    info = await probe(src)
    if not info["known"] or not info["video"]:
        raise Fail(400, "Berkas itu bukan gambar atau video yang bisa dibaca.")
    fit = qpick(request, "fit", ["contain", "cover"], "contain")
    if fit == "cover":
        scale = "scale=512:512:force_original_aspect_ratio=increase:flags=lanczos,crop=512:512"
    else:
        scale = "scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000"
    out = work / "out.webp"
    animated = not info["still"] and info["duration"] > 0.2
    if not animated:
        await ffmpeg(["-i", str(src), "-frames:v", "1", "-vf", scale, "-c:v", "libwebp", "-lossless", "0", "-q:v", "80", "-compression_level", "6"], out)
    else:
        # WhatsApp menolak stiker bergerak di atas 1 MB: turunkan mutu sampai muat.
        length = min(qfloat(request, "duration", 6, 1, 10), info["duration"] or 6)
        for q, fps in ((60, 15), (40, 12), (25, 10), (12, 8)):
            await ffmpeg(["-t", str(length), "-i", str(src), "-an", "-vf", f"fps={fps},{scale}", "-c:v", "libwebp", "-loop", "0", "-lossless", "0", "-q:v", str(q), "-compression_level", "4", "-preset", "default"], out)
            if out.stat().st_size <= 1000 * 1024:
                break
    return web.Response(body=out.read_bytes(), content_type="image/webp", headers={"cache-control": "no-store", "x-animated": "1" if animated else "0"})


# ---------------------------------------------------------------------------
# Model: dimuat saat pertama dipakai lalu disimpan di memori.
# ---------------------------------------------------------------------------
_models: dict[str, object] = {}
_model_lock = asyncio.Lock()


async def model(name: str, loader):
    async with _model_lock:
        if name not in _models:
            _models[name] = await asyncio.to_thread(loader)
        return _models[name]


async def to_png(src: Path, work: Path, max_side: int) -> Path:
    """Samakan masukan gambar jadi PNG dan batasi sisinya; sekaligus memastikan berkasnya memang gambar."""
    info = await probe(src)
    if not info["known"] or not info["video"]:
        raise Fail(400, "Berkas itu bukan gambar yang bisa dibaca. Kirim PNG, JPG, atau WebP.")
    out = work / "image.png"
    await ffmpeg(["-i", str(src), "-frames:v", "1", "-vf", f"scale='min({max_side},iw)':'min({max_side},ih)':force_original_aspect_ratio=decrease"], out, 40)
    return out


async def removebg(request: web.Request, work: Path) -> web.Response:
    src = await take_input(request, work, 10 * 1024 * 1024, "Gambar")
    png = await to_png(src, work, 2000)

    def load():
        from rembg import new_session

        return new_session(REMBG_MODEL)

    session = await model("rembg", load)

    def job() -> bytes:
        from rembg import remove

        return remove(png.read_bytes(), session=session)

    data = await asyncio.wait_for(asyncio.to_thread(job), JOB_TIMEOUT)
    return web.Response(body=data, content_type="image/png", headers={"cache-control": "no-store"})


async def ocr(request: web.Request, work: Path) -> web.Response:
    src = await take_input(request, work, 10 * 1024 * 1024, "Gambar")
    png = await to_png(src, work, 2400)

    def load():
        # rapidocr 3.x (didukung Python 3.13) memakai API objek keluaran yang berbeda
        # dari rapidocr-onnxruntime 1.x. Keduanya diterima supaya worker tetap jalan
        # di mesin lama maupun baru.
        try:
            from rapidocr import RapidOCR

            return "v3", RapidOCR()
        except ImportError:
            from rapidocr_onnxruntime import RapidOCR

            return "v2", RapidOCR()

    kind, engine = await model("ocr", load)

    def job():
        if kind == "v3":
            out = engine(str(png))
            boxes = getattr(out, "boxes", None)
            txts = getattr(out, "txts", None)
            scores = getattr(out, "scores", None)
            if boxes is None or txts is None:
                return []
            return [
                [[[float(x), float(y)] for x, y in box], str(text), float(score or 0)]
                for box, text, score in zip(boxes, txts, scores or [0] * len(txts))
            ]
        result, _ = engine(str(png))
        return result or []

    rows = await asyncio.wait_for(asyncio.to_thread(job), JOB_TIMEOUT)
    lines = group_lines(rows)
    return jres(200, {"text": "\n".join(lines), "lines": lines, "count": len(lines), "confidence": round(sum(float(r[2]) for r in rows) / len(rows), 3) if rows else 0})


def group_lines(rows: list) -> list[str]:
    """Gabungkan potongan teks yang sebaris (tinggi tengahnya berdekatan), urut dari atas ke bawah lalu kiri ke kanan."""
    items = []
    for box, text, _score in rows:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        items.append({"y": (min(ys) + max(ys)) / 2, "h": max(ys) - min(ys), "x": min(xs), "t": str(text).strip()})
    items = [i for i in items if i["t"]]
    items.sort(key=lambda i: (i["y"], i["x"]))
    lines: list[list[dict]] = []
    for it in items:
        if lines and abs(lines[-1][0]["y"] - it["y"]) <= max(lines[-1][0]["h"], it["h"]) * 0.5:
            lines[-1].append(it)
        else:
            lines.append([it])
    return [" ".join(i["t"] for i in sorted(line, key=lambda i: i["x"])) for line in lines]


async def transcribe(request: web.Request, work: Path) -> web.Response:
    src = await take_input(request, work, 25 * 1024 * 1024, "Berkas suara")
    info = await probe(src)
    need_media(info, audio=True, max_sec=MAX_SPEECH_SEC)
    lang = request.query.get("lang", "").strip().lower()
    if lang and not re.fullmatch(r"[a-z]{2,3}", lang):
        raise Fail(400, "Parameter 'lang' harus berupa kode bahasa dua huruf, misalnya id atau en.")
    wav = work / "speech.wav"
    await ffmpeg(["-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"], wav, 60)

    def load():
        from faster_whisper import WhisperModel

        return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=max(2, (os.cpu_count() or 2) - 1))

    whisper = await model("whisper", load)

    def job():
        try:
            segments, meta = whisper.transcribe(str(wav), language=lang or None, vad_filter=True, beam_size=2)
        except ValueError:
            raise Fail(400, f"Bahasa '{lang}' tidak didukung.")
        parts = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
        return parts, meta

    parts, meta = await asyncio.wait_for(asyncio.to_thread(job), JOB_TIMEOUT)
    parts = [p for p in parts if p["text"]]
    return jres(200, {"text": " ".join(p["text"] for p in parts), "language": meta.language, "duration": round(info["duration"], 2), "segments": parts})


def find_voice() -> dict:
    """Cari model suara di TTS_DIR: satu berkas .onnx, tokens.txt, dan folder espeak-ng-data."""
    if not TTS_DIR.is_dir():
        raise Fail(503, "Model suara belum terpasang di server pengolah.")
    onnx = next(iter(sorted(TTS_DIR.rglob("*.onnx"))), None)
    tokens = next(iter(sorted(TTS_DIR.rglob("tokens.txt"))), None)
    data = next((p for p in sorted(TTS_DIR.rglob("espeak-ng-data")) if p.is_dir()), None)
    if not onnx or not tokens or not data:
        raise Fail(503, "Model suara belum terpasang di server pengolah.")
    return {"model": str(onnx), "tokens": str(tokens), "data_dir": str(data), "name": onnx.stem}


async def tts(request: web.Request, work: Path) -> web.Response:
    text = re.sub(r"\s+", " ", request.query.get("text", "")).strip()
    if not text:
        raise Fail(400, "Parameter 'text' wajib diisi.")
    if len(text) > 600:
        raise Fail(400, "Teks terlalu panjang (maks 600 karakter).")
    # sherpa-onnx menahan kalimat terakhir sampai ada tanda baca penutup; tanpa itu audio bisa kosong.
    if not re.search(r"[.!?…:;\"')]$", text):
        text += "."
    speed = qfloat(request, "speed", 1.0, 0.5, 2.0)
    fmt = qpick(request, "format", ["mp3", "ogg", "wav"], "mp3")
    voice = find_voice()

    def load():
        import sherpa_onnx

        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=voice["model"], lexicon="", tokens=voice["tokens"], data_dir=voice["data_dir"]),
                provider="cpu", debug=False, num_threads=2,
            ),
            max_num_sentences=2,
        )
        if not cfg.validate():
            raise RuntimeError("konfigurasi model suara tidak valid")
        return sherpa_onnx.OfflineTts(cfg)

    engine = await model("tts", load)

    def job():
        import wave

        import numpy as np

        audio = engine.generate(text, sid=0, speed=speed)
        samples = np.asarray(audio.samples, dtype=np.float32)
        if samples.size == 0:
            raise Fail(422, "Teks itu tidak bisa diubah jadi suara.")
        pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
        with wave.open(str(work / "tts.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(audio.sample_rate)
            w.writeframes(pcm.tobytes())
        return samples.size / audio.sample_rate

    seconds = await asyncio.wait_for(asyncio.to_thread(job), JOB_TIMEOUT)
    out = work / f"out.{fmt}"
    if fmt == "wav":
        shutil.move(str(work / "tts.wav"), out)
    elif fmt == "ogg":
        await ffmpeg(["-i", str(work / "tts.wav"), "-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-ar", "48000"], out, 60)
    else:
        await ffmpeg(["-i", str(work / "tts.wav"), "-c:a", "libmp3lame", "-b:a", "64k", "-ac", "1"], out, 60)
    return jres(200, {**publish(out, fmt), "duration": round(seconds, 2), "voice": voice["name"], "characters": len(text)})


JOBS = {"ssweb": ssweb, "web2pdf": web2pdf, "turnstile": turnstile, "diag": diag, "tomp3": tomp3, "togif": togif, "compress": compress, "sticker": sticker, "removebg": removebg, "ocr": ocr, "transcribe": transcribe, "tts": tts}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
async def handle_job(request: web.Request) -> web.Response:
    given = request.headers.get("x-worker-key", "")
    if not KEY or not hmac.compare_digest(given.encode(), KEY.encode()):
        return jres(401, {"error": "Kunci worker tidak cocok."})
    name = request.match_info["job"]
    fn = JOBS.get(name)
    if not fn:
        return jres(404, {"error": "Tugas tidak dikenal."})
    work = Path(tempfile.mkdtemp(prefix=f"{name}-", dir=DATA / "tmp"))
    started = time.time()
    try:
        async with Slot():
            res = await asyncio.wait_for(fn(request, work), JOB_TIMEOUT + 15)
        _stats["done"] += 1
        res.headers["x-job-ms"] = str(int((time.time() - started) * 1000))
        return res
    except Fail as e:
        if e.status >= 500:
            _stats["failed"] += 1
        return jres(e.status, {"error": e.message})
    except asyncio.TimeoutError:
        _stats["failed"] += 1
        return jres(504, {"error": "Pengolahan terlalu lama dan dihentikan. Coba berkas yang lebih pendek atau lebih kecil."})
    except Exception as e:  # noqa: BLE001
        _stats["failed"] += 1
        print(f"[{name}] {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return jres(500, {"error": "Server pengolah gagal mengerjakan permintaan ini."})
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def handle_file(request: web.Request) -> web.StreamResponse:
    name = request.match_info["name"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,40}\.[a-z0-9]{2,4}", name):
        return jres(404, {"error": "Berkas tidak ditemukan."})
    path = OUT / name
    if not path.is_file():
        return jres(404, {"error": "Berkas tidak ditemukan atau sudah dihapus."})
    ext = name.rsplit(".", 1)[1]
    headers = {"content-type": TYPES.get(ext, "application/octet-stream"), "cache-control": "public, max-age=600", "access-control-allow-origin": "*", "x-content-type-options": "nosniff"}
    if request.query.get("download") == "1":
        headers["content-disposition"] = f'attachment; filename="yanz-{name[:8]}.{ext}"'
    return web.FileResponse(path, headers=headers)


async def handle_health(request: web.Request) -> web.Response:
    body = {"ok": True, "service": "yanz-worker", "version": VERSION}
    given = request.headers.get("x-worker-key", "")
    if KEY and hmac.compare_digest(given.encode(), KEY.encode()):
        # Rincian hanya untuk pemilik kunci.
        disk = shutil.disk_usage(DATA)
        body.update({
            "jobs": list(JOBS), "running": MAX_JOBS - _slots._value, "waiting": _waiting, "max_jobs": MAX_JOBS,
            "done": _stats["done"], "failed": _stats["failed"], "uptime": int(time.time() - _stats["started"]),
            "disk_free_mb": disk.free // 1024 // 1024, "models_loaded": sorted(_models),
        })
    return jres(200, body)


async def sweeper(app: web.Application):
    """Hapus berkas hasil yang sudah lewat FILE_TTL dan folder kerja yang tertinggal."""
    async def loop():
        while True:
            now = time.time()
            for folder, ttl in ((OUT, FILE_TTL), (DATA / "tmp", 1800)):
                try:
                    for p in folder.iterdir():
                        if now - p.stat().st_mtime > ttl:
                            shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
                except OSError:
                    pass
            await asyncio.sleep(120)

    task = asyncio.create_task(loop())
    yield
    task.cancel()
    if _browser:
        try:
            await _browser.close()
        except Exception:
            pass


def make_app() -> web.Application:
    if len(KEY) < 24:
        sys.exit("WORKER_KEY belum diisi atau terlalu pendek (min. 24 karakter). Jalankan install.sh untuk membuatnya.")
    OUT.mkdir(parents=True, exist_ok=True)
    (DATA / "tmp").mkdir(parents=True, exist_ok=True)
    app = web.Application(client_max_size=MAX_INPUT + 1024 * 1024)
    app.router.add_get("/", handle_health)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/f/{name}", handle_file)
    app.router.add_post("/v1/{job}", handle_job)
    app.cleanup_ctx.append(sweeper)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="0.0.0.0", port=PORT, access_log=None, print=lambda *_: print(f"yanz-worker {VERSION} di port {PORT}", flush=True))
