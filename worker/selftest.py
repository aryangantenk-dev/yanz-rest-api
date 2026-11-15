"""
Uji cepat semua fitur worker dari dalam kontainer:
    docker compose exec worker python selftest.py
Membuat berkas uji dengan ffmpeg, memanggil tiap rute, lalu mencetak LULUS atau GAGAL per fitur.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = os.environ.get("SELFTEST_URL", f"http://127.0.0.1:{os.environ.get('PORT', '8080')}")
KEY = os.environ.get("WORKER_KEY", "")
FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
ONLY = set(sys.argv[1:])

results: list[tuple[str, bool, str]] = []


def call(job: str, params: dict, body: bytes | None = None, timeout: int = 240):
    url = f"{BASE}/v1/{job}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, data=body if body is not None else b"", method="POST", headers={"x-worker-key": KEY, "content-type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type", ""), e.read()


def check(name: str, fn) -> None:
    if ONLY and name not in ONLY:
        return
    started = time.time()
    try:
        note = fn()
        results.append((name, True, f"{note} ({time.time() - started:.1f} dtk)"))
    except Exception as e:  # noqa: BLE001
        results.append((name, False, f"{type(e).__name__}: {str(e)[:300]}"))
    ok, text = results[-1][1], results[-1][2]
    print(f"{'LULUS' if ok else 'GAGAL'}  {name:<11} {text}", flush=True)


def expect_json(res) -> dict:
    status, ctype, data = res
    if status != 200:
        raise RuntimeError(f"status {status}: {data[:200].decode('utf-8', 'replace')}")
    return json.loads(data)


def expect_bytes(res, prefix: str, magic: bytes) -> bytes:
    status, ctype, data = res
    if status != 200:
        raise RuntimeError(f"status {status}: {data[:200].decode('utf-8', 'replace')}")
    if not ctype.startswith(prefix) or magic not in data[:16]:
        raise RuntimeError(f"isi tidak sesuai ({ctype}, {len(data)} byte)")
    return data


def fetch_file(name: str) -> int:
    with urllib.request.urlopen(f"{BASE}/f/{name}", timeout=30) as r:
        return len(r.read())


def main() -> int:
    if not KEY:
        print("WORKER_KEY kosong.")
        return 2
    tmp = Path(tempfile.mkdtemp())
    video, image, text_img = tmp / "v.mp4", tmp / "i.png", tmp / "t.png"
    quiet = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"]
    subprocess.run([*quiet, "-f", "lavfi", "-i", "testsrc=duration=5:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(video)], check=True)
    subprocess.run([*quiet, "-f", "lavfi", "-i", "testsrc=duration=1:size=600x400:rate=1", "-frames:v", "1", str(image)], check=True)
    subprocess.run([*quiet, "-f", "lavfi", "-i", "color=white:size=900x200:duration=1:rate=1", "-vf", "drawtext=text='Selamat datang di yanz api 2026':fontsize=48:fontcolor=black:x=30:y=70", "-frames:v", "1", str(text_img)], check=True)
    v, i, t = video.read_bytes(), image.read_bytes(), text_img.read_bytes()
    speech: dict = {}

    def health():
        with urllib.request.urlopen(f"{BASE}/health", timeout=10) as r:
            body = json.loads(r.read())
        if not body.get("ok"):
            raise RuntimeError("health tidak ok")
        return f"versi {body.get('version')}"

    def auth():
        req = urllib.request.Request(f"{BASE}/v1/ocr", data=b"", method="POST", headers={"x-worker-key": "salah"})
        try:
            urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                return "kunci salah ditolak"
            raise RuntimeError(f"status {e.code}")
        raise RuntimeError("kunci salah diterima")

    def guard():
        status, _, data = call("tomp3", {"url": "http://127.0.0.1:8080/health"})
        if status != 400:
            raise RuntimeError(f"alamat internal tidak ditolak (status {status})")
        return "alamat internal ditolak"

    def ssweb():
        data = expect_bytes(call("ssweb", {"url": "https://example.com"}), "image/png", b"PNG")
        return f"{len(data) // 1024} KB"

    def web2pdf():
        body = expect_json(call("web2pdf", {"url": "https://example.com"}))
        return f"{fetch_file(body['file']) // 1024} KB, judul '{body.get('title')}'"

    def tomp3():
        body = expect_json(call("tomp3", {}, v))
        return f"{fetch_file(body['file']) // 1024} KB, {body['duration']} dtk"

    def togif():
        body = expect_json(call("togif", {"duration": "3"}, v))
        return f"{body['size'] // 1024} KB"

    def compress():
        body = expect_json(call("compress", {"quality": "low"}, v))
        return f"{body['size_before'] // 1024} KB jadi {body['size'] // 1024} KB"

    def sticker():
        a = expect_bytes(call("sticker", {}, i), "image/webp", b"WEBP")
        b = expect_bytes(call("sticker", {}, v), "image/webp", b"WEBP")
        return f"diam {len(a) // 1024} KB, bergerak {len(b) // 1024} KB"

    def removebg():
        data = expect_bytes(call("removebg", {}, i), "image/png", b"PNG")
        return f"{len(data) // 1024} KB"

    def ocr():
        body = expect_json(call("ocr", {}, t))
        if "yanz" not in body["text"].lower():
            raise RuntimeError(f"teks tidak terbaca: {body['text']!r}")
        return f"terbaca: {body['text']!r}"

    def tts():
        body = expect_json(call("tts", {"text": "Halo, selamat datang di yanz api. Ini adalah uji suara.", "format": "mp3"}))
        with urllib.request.urlopen(f"{BASE}/f/{body['file']}", timeout=30) as r:
            speech["mp3"] = r.read()
        return f"{body['duration']} dtk, suara {body['voice']}"

    def transcribe():
        if "mp3" not in speech:
            raise RuntimeError("butuh hasil tts sebagai bahan uji")
        body = expect_json(call("transcribe", {"lang": "id"}, speech["mp3"]))
        if not body["text"].strip():
            raise RuntimeError("hasil kosong")
        return f"terbaca: {body['text']!r}"

    for name, fn in (("health", health), ("kunci", auth), ("penjaga", guard), ("ssweb", ssweb), ("web2pdf", web2pdf), ("tomp3", tomp3), ("togif", togif),
                     ("compress", compress), ("sticker", sticker), ("removebg", removebg), ("ocr", ocr), ("tts", tts), ("transcribe", transcribe)):
        check(name, fn)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} lulus, {len(failed)} gagal")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
