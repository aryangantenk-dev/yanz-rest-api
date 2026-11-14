#!/usr/bin/env bash
# Pemasang "film-proxy" untuk VPS Ubuntu (22.04 / 24.04).
#
# Fungsinya: meneruskan permintaan dari yanz.api (Vercel) ke situs film lewat
# IP VPS ini. Hanya host di ALLOW_HOSTS yang diteruskan, dan hanya bila
# permintaan membawa header x-proxy-key yang benar.
#
# Pakai:
#   sudo bash install.sh          tes situs dulu, pasang bila ada yang lolos
#   TEST_ONLY=1 bash install.sh   hanya tes, tidak memasang apa pun
#   sudo FORCE=1 bash install.sh  pasang walau semua tes gagal
#   sudo TUNNEL=1 bash install.sh pasang + buka terowongan (untuk VPS/container NAT
#                                 yang port-nya tidak bisa dijangkau dari luar)
#   sudo bash install.sh url      tampilkan alamat terowongan yang sedang aktif
#   sudo SOLVER=1 bash install.sh pasang juga pemecah Turnstile untuk /api/tools/zefame-order
#   sudo bash install.sh solver-test   uji pemecah Turnstile yang sudah terpasang
#   sudo bash install.sh uninstall
#
# TUNNEL: auto (bawaan; terowongan dibuka bila IP publik bukan milik mesin ini),
#         1 (selalu), 0 (jangan). Terowongan memakai cloudflared "quick tunnel":
#         tanpa akun, tetapi alamatnya BERGANTI setiap layanan/VPS dinyalakan ulang.
#         Menjalankan ulang skrip ini TIDAK mengganti alamat selama terowongan lama masih
#         hidup; pakai NEW_TUNNEL=1 bila memang ingin alamat baru.
#
# SOLVER: auto (bawaan; pemecah yang sudah terpasang dibiarkan), 1 (pasang/perbarui), 0 (copot).
#         Pemecahnya EzSolver (https://github.com/ismoiloffS/EzSolver, lisensi MIT, buatan
#         Ismoiloff): Chrome asli + Xvfb yang mengambil token Turnstile untuk halaman di
#         SOLVE_HOSTS. Ia hanya mendengarkan di 127.0.0.1; dari luar hanya bisa dipakai lewat
#         film-proxy (POST /solve + header x-proxy-key). Butuh sekitar 1,2 GB disk dan
#         RAM kosong kurang lebih 500 MB.
set -euo pipefail

PORT="${PORT:-8787}"
ALLOW_HOSTS="${ALLOW_HOSTS:-lk21official.cc,nontondrama.vip,lk21.de,idlixku.com,sankanime.web.id,sankavollerei.web.id}"
APP_DIR=/opt/film-proxy
ENV_FILE=/etc/film-proxy.env
UNIT=/etc/systemd/system/film-proxy.service
TUNNEL_UNIT=/etc/systemd/system/film-proxy-tunnel.service
TUNNEL_LOG=/var/log/film-proxy-tunnel.log
CF_BIN=/usr/local/bin/cloudflared
SOLVE_HOSTS="${SOLVE_HOSTS:-zefame.com}"
SOLVE_SITEKEY=0x4AAAAAACWzOmyoRZoUyJWP
SOLVE_URL=https://zefame.com/free-services
SOLVER_PORT=8191
SOLVER_DIR=/opt/ezsolver
SOLVER_HOME=/var/lib/ezsolver
SOLVER_USER=ezsolver
SOLVER_UNIT=/etc/systemd/system/ezsolver.service
SOLVER_LOG=/var/log/ezsolver.log
# Versi EzSolver yang isinya sudah dibaca; berkasnya dicocokkan dengan sidik jari ini sebelum dipakai.
SOLVER_REF=5eefb0043825389d7b93664295803da95328a79b
SOLVER_SHA_SOLVER=69c6a784e06b6fa1312241961e88c91b8fe74c61cea87c24b289e77a56de9568
SOLVER_SHA_SERVICE=589fd5c8c55c9f01b9506cccb6d958d736cc3fa54cb06a070891ce5d90618949
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }
tunnel_url() { # alamat terowongan terakhir yang tercatat di log
  { grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null || true; } | { grep -v '//api\.' || true; } | tail -n1
}

solver_health() { curl -s --max-time 4 "http://127.0.0.1:$SOLVER_PORT/health" 2>/dev/null | grep -q '"ok"'; }
solver_logs() {
  if has_systemd; then journalctl -u ezsolver -n 15 --no-pager 2>/dev/null || true
  else tail -n 15 "$SOLVER_LOG" 2>/dev/null || true; fi
}
solver_test() { # minta satu token sungguhan untuk halaman Zefame, cetak LOLOS/GAGAL
  local out
  out="$(curl -s --max-time 90 -X POST "http://127.0.0.1:$SOLVER_PORT/solve" -H 'Content-Type: application/json' \
    -d "{\"sitekey\":\"$SOLVE_SITEKEY\",\"siteurl\":\"$SOLVE_URL\",\"timeout\":60}" 2>/dev/null || true)"
  printf '%s' "$out" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read() or "{}")
except ValueError:
    d = {}
t = d.get("token") if isinstance(d, dict) else None
if isinstance(t, str) and t:
    print("LOLOS (%s detik, token %d karakter)" % (d.get("elapsed", "?"), len(t)))
else:
    err = d.get("error") if isinstance(d, dict) else None
    print("GAGAL: " + str(err or "pemecah tidak menjawab")[:200])
'
}
solver_stop() {
  if has_systemd; then systemctl disable --now ezsolver 2>/dev/null || true; fi
  pkill -f "$SOLVER_DIR/app/service.py" 2>/dev/null || true
}

if [ "${1:-}" = "solver-test" ]; then
  if ! solver_health; then
    echo "Pemecah Turnstile tidak berjalan. Pasang dengan: sudo SOLVER=1 bash install.sh"
    solver_logs
    exit 1
  fi
  echo "SOLVER TES: $(solver_test)"
  exit 0
fi

if [ "${1:-}" = "url" ]; then
  U="$(tunnel_url)"
  if [ -n "$U" ]; then echo "PROXY_URL=$U"; else echo "Terowongan belum aktif. Jalankan: TUNNEL=1 bash install.sh"; fi
  exit 0
fi

if [ "${1:-}" = "uninstall" ]; then
  [ "$(id -u)" = 0 ] || { echo "Jalankan dengan sudo."; exit 1; }
  if has_systemd; then systemctl disable --now film-proxy film-proxy-tunnel 2>/dev/null || true; fi
  pkill -f "$APP_DIR/proxy.py" 2>/dev/null || true
  pkill -f "$CF_BIN tunnel" 2>/dev/null || true
  solver_stop
  rm -rf "$APP_DIR" "$ENV_FILE" "$UNIT" "$TUNNEL_UNIT" "$TUNNEL_LOG" "$CF_BIN" "$SOLVER_DIR" "$SOLVER_HOME" "$SOLVER_UNIT" "$SOLVER_LOG"
  if id "$SOLVER_USER" >/dev/null 2>&1; then userdel "$SOLVER_USER" 2>/dev/null || true; fi
  if has_systemd; then systemctl daemon-reload || true; fi
  echo "film-proxy sudah dihapus. Paket Chrome dan Xvfb (bila tadinya dipasang untuk pemecah Turnstile) dibiarkan."
  exit 0
fi

command -v curl >/dev/null 2>&1 || { echo "curl belum ada. Jalankan: apt update && apt install -y curl"; exit 1; }

# ---------------------------------------------------------------- 1. tes situs
PASS=0
RESULT=""
BODY="$(mktemp)"
SOLVER_TMP=""
trap 'rm -rf "$BODY" ${SOLVER_TMP:+"$SOLVER_TMP"}' EXIT

check() { # check NAMA URL [opsi curl tambahan...]
  local name="$1" url="$2" out code final verdict
  shift 2
  out="$(curl -sS -L --max-redirs 5 --max-time 20 --compressed -A "$UA" \
    -H 'Accept-Language: id-ID,id;q=0.9,en;q=0.8' "$@" \
    -o "$BODY" -w '%{http_code} %{url_effective}' "$url" 2>/dev/null || true)"
  code="${out%% *}"
  final="${out#* }"
  if [ "$code" = "200" ] && ! printf '%s' "$final" | grep -q '404\.html' \
    && ! grep -qiE 'just a moment|attention required|cf-chl|challenges\.cloudflare\.com' "$BODY"; then
    verdict="LOLOS"
    PASS=$((PASS + 1))
  else
    verdict="DIBLOKIR"
  fi
  printf '  %-10s %-9s (HTTP %s, %s)\n' "$name" "$verdict" "${code:-000}" "${final:-tidak ada jawaban}"
  RESULT="$RESULT $name=$verdict"
}

echo
echo "== Tes akses situs film dari VPS ini =="
check LK21 "https://tv12.lk21official.cc/avatar-2009"
check IDLIX "https://z2.idlixku.com/api/genres" -H 'Accept: application/json' -H 'Origin: https://z2.idlixku.com' -e 'https://z2.idlixku.com/'
check SANKANIME "https://sankanime.web.id/movies"
check SANKA_API "https://www.sankavollerei.web.id/plananimek/movie/genres" -H 'Accept: application/json, text/plain, */*' -H 'Origin: https://sankanime.web.id' -e 'https://sankanime.web.id/'
echo

if [ "${TEST_ONLY:-}" = "1" ]; then
  echo "HASIL TES:$RESULT"
  exit 0
fi

# SOLVER=1 tetap memasang (pemecah tidak bergantung pada situs film); SOLVER=0 tetap mencopot bila proxy sudah ada.
if [ "$PASS" = "0" ] && [ "${FORCE:-}" != "1" ] && [ "${SOLVER:-}" != "1" ] \
  && ! { [ "${SOLVER:-}" = "0" ] && [ -f "$ENV_FILE" ]; }; then
  echo "Semua situs menolak IP VPS ini, jadi proxy TIDAK dipasang."
  echo "HASIL TES:$RESULT"
  exit 0
fi

# ------------------------------------------------------------------ 2. pasang
[ "$(id -u)" = 0 ] || { echo "Tes selesai. Untuk memasang, jalankan ulang dengan sudo."; exit 1; }

if ! command -v python3 >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq python3 ca-certificates
fi

mkdir -p "$APP_DIR"
cat > "$APP_DIR/proxy.py" <<'PYEOF'
#!/usr/bin/env python3
"""film-proxy: meneruskan GET /fetch?url=... ke host yang diizinkan memakai curl.

Bila pemecah Turnstile (EzSolver) terpasang di mesin ini, POST /solve meneruskan
permintaan token ke 127.0.0.1:SOLVER_PORT, hanya untuk halaman di SOLVE_HOSTS.
"""
import hmac
import json
import os
import re
import socket
import subprocess
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

KEY = os.environ.get("PROXY_KEY", "")
PORT = int(os.environ.get("PORT", "8787"))
ALLOW = [h.strip().lower() for h in os.environ.get("ALLOW_HOSTS", "").split(",") if h.strip()]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
MAX_BYTES = 5 * 1024 * 1024
SAFE_HEADER = re.compile(r"^[\w/+*.,;=\- ]{1,150}$")
SOLVER_PORT = int(os.environ.get("SOLVER_PORT", "0") or "0")
SOLVE_HOSTS = [h.strip().lower() for h in os.environ.get("SOLVE_HOSTS", "").split(",") if h.strip()]
SITEKEY = re.compile(r"^[0-9A-Za-z_-]{10,80}$")
# Pemecah mengerjakan satu permintaan pada satu waktu; sisanya mengantre, paling banyak dua.
SOLVE_SLOTS = threading.BoundedSemaphore(3)


def allowed(url, hosts=None):
    hosts = ALLOW if hosts is None else hosts
    try:
        t = urlsplit(url)
    except ValueError:
        return False
    host = (t.hostname or "").lower()
    if t.scheme != "https" or not host or t.username or t.password:
        return False
    if any(ord(c) <= 32 or ord(c) == 127 for c in url):
        return False
    return any(host == h or host.endswith("." + h) for h in hosts)


class Handler(BaseHTTPRequestHandler):
    server_version = "film-proxy"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    def reply(self, code, body, ctype="text/plain; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def reply_json(self, code, data):
        self.reply(code, json.dumps(data), "application/json; charset=utf-8")

    def do_POST(self):
        if urlsplit(self.path).path != "/solve":
            return self.reply_json(404, {"error": "not_found"})
        if not KEY or not hmac.compare_digest(self.headers.get("x-proxy-key", ""), KEY):
            return self.reply_json(401, {"error": "unauthorized"})
        if not SOLVER_PORT:
            return self.reply_json(503, {"error": "solver_not_installed"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 2 or length > 4096:
            return self.reply_json(400, {"error": "bad_request"})
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            data = None
        if not isinstance(data, dict):
            return self.reply_json(400, {"error": "bad_request"})
        sitekey, siteurl = data.get("sitekey"), data.get("siteurl")
        if not isinstance(sitekey, str) or not SITEKEY.match(sitekey):
            return self.reply_json(400, {"error": "bad_sitekey"})
        if not isinstance(siteurl, str) or len(siteurl) > 500 or any(c in "'\"\\`" for c in siteurl) or not allowed(siteurl, SOLVE_HOSTS):
            return self.reply_json(400, {"error": "target_not_allowed"})
        try:
            timeout = int(data.get("timeout", 45))
        except (TypeError, ValueError):
            timeout = 45
        timeout = max(10, min(timeout, 60))

        if not SOLVE_SLOTS.acquire(blocking=False):
            return self.reply_json(429, {"error": "busy"})
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:%d/solve" % SOLVER_PORT,
                data=json.dumps({"sitekey": sitekey, "siteurl": siteurl, "timeout": timeout}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout + 20) as r:
                    out = json.loads(r.read().decode("utf-8", "replace"))
            except urllib.error.HTTPError as e:
                try:
                    detail = str(json.loads(e.read().decode("utf-8", "replace")).get("error", ""))
                except (ValueError, AttributeError):
                    detail = ""
                return self.reply_json(502, {"error": "solve_failed", "detail": detail[:300]})
            except socket.timeout:
                return self.reply_json(504, {"error": "timeout"})
            except urllib.error.URLError as e:
                if isinstance(e.reason, socket.timeout):
                    return self.reply_json(504, {"error": "timeout"})
                return self.reply_json(503, {"error": "solver_down"})
            except (OSError, ValueError):
                return self.reply_json(503, {"error": "solver_down"})
        finally:
            SOLVE_SLOTS.release()
        token = out.get("token") if isinstance(out, dict) else None
        if not isinstance(token, str) or not token:
            return self.reply_json(502, {"error": "solve_failed", "detail": "pemecah tidak memberikan token"})
        self.reply_json(200, {"token": token, "elapsed": out.get("elapsed")})

    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/health":
            return self.reply(200, "ok")
        if u.path != "/fetch":
            return self.reply(404, "not found")
        if not KEY or not hmac.compare_digest(self.headers.get("x-proxy-key", ""), KEY):
            return self.reply(401, "unauthorized")

        q = parse_qs(u.query)
        target = q.get("url", [""])[0]
        if not allowed(target):
            return self.reply(400, "url tidak diizinkan")

        cmd = [
            "curl", "-sS", "-L", "--max-redirs", "5", "--proto", "=https", "--proto-redir", "=https",
            "--compressed", "--max-time", "20", "--max-filesize", str(MAX_BYTES),
            "-A", UA, "-H", "Accept-Language: id-ID,id;q=0.9,en;q=0.8",
        ]
        accept = q.get("accept", [""])[0]
        if accept and SAFE_HEADER.match(accept):
            cmd += ["-H", "Accept: " + accept]
        referer = q.get("referer", [""])[0]
        if referer and allowed(referer):
            cmd += ["-e", referer]
            t = urlsplit(referer)
            if q.get("origin", [""])[0] == "1":
                cmd += ["-H", "Origin: https://" + t.hostname]
        if q.get("xhr", [""])[0] == "1":
            cmd += ["-H", "X-Requested-With: XMLHttpRequest"]
        cmd += ["-w", "\n%{http_code}\t%{content_type}\t%{url_effective}", "--", target]

        try:
            p = subprocess.run(cmd, capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            return self.reply(504, "timeout")
        body, _, meta = p.stdout.rpartition(b"\n")
        parts = meta.decode("utf-8", "replace").split("\t")
        if len(parts) != 3 or not parts[0].isdigit() or int(parts[0]) < 100:
            return self.reply(502, "gagal mengambil: " + p.stderr.decode("utf-8", "replace")[:300])
        code, ctype, final = int(parts[0]), parts[1], parts[2]
        if not allowed(final):
            return self.reply(502, "dialihkan ke host di luar daftar izin", extra={"x-final-url": final[:500]})
        self.reply(code, body, ctype or "application/octet-stream", {"x-final-url": final[:500], "x-upstream-status": str(code)})


if __name__ == "__main__":
    if not KEY:
        raise SystemExit("PROXY_KEY belum diatur")
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    srv.serve_forever()
PYEOF
chmod 755 "$APP_DIR/proxy.py"

# ------------------------------------------- 2b. pemecah Turnstile (opsional)
SOLVER="${SOLVER:-auto}"
if [ "$SOLVER" = "auto" ]; then
  if [ -f "$SOLVER_DIR/app/service.py" ]; then SOLVER=keep; else SOLVER=0; fi
fi
SOLVER_STATE="tidak dipasang"
SOLVER_TEST=""

find_chrome() { # jalur Chrome/Chromium yang benar-benar bisa dijalankan
  local c
  for c in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$c" ] && timeout 20 "$c" --version >/dev/null 2>&1; then echo "$c"; return 0; fi
  done
  return 0
}

solver_start() { # solver_start USER CHROME -> 0 bila /health menjawab
  local user="$1" chrome="$2" home profile
  if [ "$user" = "root" ]; then
    home=/root
    profile="$SOLVER_HOME/profile-root"
  else
    home="$SOLVER_HOME"
    profile="$SOLVER_HOME/profile"
  fi
  mkdir -p "$profile"
  chown -R "$user" "$profile" 2>/dev/null || true
  solver_stop
  if has_systemd; then
    cat > "$SOLVER_UNIT" <<EOF
[Unit]
Description=EzSolver (pemecah Turnstile untuk yanz.api, hanya di 127.0.0.1:$SOLVER_PORT)
After=network-online.target
Wants=network-online.target

[Service]
User=$user
Environment=PORT=$SOLVER_PORT
Environment=CHROME_PATH=$chrome
Environment=TS_PROFILE_DIR=$profile
Environment=HOME=$home
Environment=PYTHONUNBUFFERED=1
WorkingDirectory=$SOLVER_DIR/app
ExecStartPre=+/bin/mkdir -p -m 1777 /tmp/.X11-unix
ExecStart=$SOLVER_DIR/venv/bin/python $SOLVER_DIR/app/service.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "$SOLVER_UNIT"
    systemctl daemon-reload
    systemctl enable ezsolver >/dev/null 2>&1 || true
    systemctl restart ezsolver || true
  else
    mkdir -p -m 1777 /tmp/.X11-unix 2>/dev/null || true
    ( cd "$SOLVER_DIR/app" && PORT="$SOLVER_PORT" CHROME_PATH="$chrome" TS_PROFILE_DIR="$profile" HOME="$home" PYTHONUNBUFFERED=1 \
        nohup "$SOLVER_DIR/venv/bin/python" "$SOLVER_DIR/app/service.py" </dev/null >>"$SOLVER_LOG" 2>&1 & )
  fi
  for _ in $(seq 1 30); do
    sleep 2
    if solver_health; then return 0; fi
  done
  return 1
}

install_solver() { # mengisi SOLVER_STATE; 0 bila pemecah hidup
  local arch mem_mb free_mb chrome old_umask
  command -v apt-get >/dev/null 2>&1 || { SOLVER_STATE="GAGAL: butuh apt-get (Ubuntu/Debian)"; return 1; }
  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || true)"
  free_mb="$(df -Pm /opt 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  echo "  RAM total   : ${mem_mb:-?} MB"
  echo "  Disk kosong : ${free_mb:-?} MB"
  if [ "${mem_mb:-0}" -lt 900 ]; then echo "  Peringatan  : RAM di bawah 900 MB, Chrome bisa kehabisan memori."; fi
  if [ -n "$free_mb" ] && [ "$free_mb" -lt 1200 ]; then SOLVER_STATE="GAGAL: disk kosong kurang dari 1200 MB"; return 1; fi

  old_umask="$(umask)"
  umask 022
  export DEBIAN_FRONTEND=noninteractive
  echo "  Memasang paket (xvfb, python3-venv)..."
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq xvfb python3-venv ca-certificates tar >/dev/null 2>&1 \
    || { umask "$old_umask"; SOLVER_STATE="GAGAL: apt-get install xvfb python3-venv"; return 1; }

  chrome="$(find_chrome)"
  if [ -z "$chrome" ]; then
    echo "  Memasang Chrome (unduhan sekitar 120 MB)..."
    SOLVER_TMP="$(mktemp -d)"
    arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
    if [ "$arch" = "amd64" ] || [ "$arch" = "x86_64" ]; then
      curl -fsSL --retry 2 --max-time 600 -o "$SOLVER_TMP/chrome.deb" \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
        && apt-get install -y -qq "$SOLVER_TMP/chrome.deb" >/dev/null 2>&1 || true
    else
      apt-get install -y -qq chromium >/dev/null 2>&1 || apt-get install -y -qq chromium-browser >/dev/null 2>&1 || true
    fi
    rm -rf "$SOLVER_TMP"
    SOLVER_TMP=""
    chrome="$(find_chrome)"
  fi
  [ -n "$chrome" ] || { umask "$old_umask"; SOLVER_STATE="GAGAL: Chrome tidak bisa dipasang di mesin ini ($(uname -m))"; return 1; }
  echo "  Chrome      : $chrome"

  echo "  Mengunduh EzSolver..."
  SOLVER_TMP="$(mktemp -d)"
  mkdir -p "$SOLVER_DIR"
  rm -rf "$SOLVER_DIR/app.new"
  mkdir -p "$SOLVER_DIR/app.new"
  if ! curl -fsSL --retry 2 --max-time 120 -o "$SOLVER_TMP/src.tgz" "https://codeload.github.com/ismoiloffS/EzSolver/tar.gz/$SOLVER_REF" \
    || ! tar -xzf "$SOLVER_TMP/src.tgz" -C "$SOLVER_DIR/app.new" --strip-components=1; then
    umask "$old_umask"; SOLVER_STATE="GAGAL: tidak bisa mengunduh EzSolver dari GitHub"; return 1
  fi
  rm -rf "$SOLVER_TMP"
  SOLVER_TMP=""
  if ! ( cd "$SOLVER_DIR/app.new" && printf '%s  solver.py\n%s  service.py\n' "$SOLVER_SHA_SOLVER" "$SOLVER_SHA_SERVICE" | sha256sum -c --status - ); then
    rm -rf "$SOLVER_DIR/app.new"
    umask "$old_umask"; SOLVER_STATE="GAGAL: isi EzSolver berbeda dari versi yang sudah diperiksa"; return 1
  fi
  # Aslinya mendengarkan di 0.0.0.0 tanpa kunci; di sini dikunci ke 127.0.0.1.
  sed -i 's/ThreadedHTTPServer(("0\.0\.0\.0", PORT), Handler)/ThreadedHTTPServer(("127.0.0.1", PORT), Handler)/' "$SOLVER_DIR/app.new/service.py"
  if ! grep -q 'ThreadedHTTPServer(("127.0.0.1", PORT), Handler)' "$SOLVER_DIR/app.new/service.py"; then
    rm -rf "$SOLVER_DIR/app.new"
    umask "$old_umask"; SOLVER_STATE="GAGAL: tidak bisa mengunci EzSolver ke 127.0.0.1"; return 1
  fi
  solver_stop
  rm -rf "$SOLVER_DIR/app"
  mv "$SOLVER_DIR/app.new" "$SOLVER_DIR/app"

  echo "  Memasang nodriver..."
  if [ ! -x "$SOLVER_DIR/venv/bin/python" ]; then python3 -m venv "$SOLVER_DIR/venv" >/dev/null 2>&1 || true; fi
  if ! "$SOLVER_DIR/venv/bin/pip" install -q --disable-pip-version-check --upgrade nodriver >/dev/null 2>&1 \
    || ! "$SOLVER_DIR/venv/bin/python" -c 'import nodriver' >/dev/null 2>&1; then
    umask "$old_umask"; SOLVER_STATE="GAGAL: pip install nodriver"; return 1
  fi

  if ! id "$SOLVER_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$SOLVER_HOME" --shell /usr/sbin/nologin "$SOLVER_USER" >/dev/null 2>&1 || true
  fi
  mkdir -p "$SOLVER_HOME"
  if id "$SOLVER_USER" >/dev/null 2>&1; then chown "$SOLVER_USER" "$SOLVER_HOME" 2>/dev/null || true; fi
  umask "$old_umask"

  echo "  Menyalakan pemecah (menunggu Chrome siap, paling lama 1 menit)..."
  if has_systemd && id "$SOLVER_USER" >/dev/null 2>&1 && solver_start "$SOLVER_USER" "$chrome"; then
    SOLVER_STATE="hidup (pengguna $SOLVER_USER)"
    return 0
  fi
  # Di banyak container, sandbox Chrome tidak bisa dipakai pengguna biasa; EzSolver mematikannya bila berjalan sebagai root.
  if solver_start root "$chrome"; then
    SOLVER_STATE="hidup (sebagai root, sandbox Chrome mati)"
    return 0
  fi
  SOLVER_STATE="GAGAL: pemecah tidak mau menyala (Chrome atau Xvfb), lihat log di atas"
  return 1
}

case "$SOLVER" in
  1)
    echo "== Memasang pemecah Turnstile (EzSolver) =="
    if install_solver; then
      echo "  Meminta satu token untuk $SOLVE_URL ..."
      SOLVER_TEST="$(solver_test)"
    else
      solver_logs
    fi
    echo "  Status      : $SOLVER_STATE"
    if [ -n "$SOLVER_TEST" ]; then echo "  Tes token   : $SOLVER_TEST"; fi
    echo
    ;;
  keep)
    if solver_health; then SOLVER_STATE="hidup (tidak diubah)"; else SOLVER_STATE="terpasang tetapi tidak menjawab; pasang ulang dengan SOLVER=1"; fi
    ;;
  0)
    if [ -e "$SOLVER_DIR" ] || [ -e "$SOLVER_UNIT" ]; then
      solver_stop
      rm -rf "$SOLVER_DIR" "$SOLVER_HOME" "$SOLVER_UNIT" "$SOLVER_LOG"
      if id "$SOLVER_USER" >/dev/null 2>&1; then userdel "$SOLVER_USER" 2>/dev/null || true; fi
      if has_systemd; then systemctl daemon-reload || true; fi
      SOLVER_STATE="dicopot"
    fi
    ;;
  *)
    echo "Nilai SOLVER tidak dikenal: $SOLVER (pakai 1, 0, atau auto)."
    exit 1
    ;;
esac

# Pakai ulang kunci lama bila sudah pernah dipasang.
KEY=""
if [ -f "$ENV_FILE" ]; then KEY="$(sed -n 's/^PROXY_KEY=//p' "$ENV_FILE" | head -n1)"; fi
if [ -z "$KEY" ]; then KEY="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"; fi
umask 077
printf 'PROXY_KEY=%s\nPORT=%s\nALLOW_HOSTS=%s\n' "$KEY" "$PORT" "$ALLOW_HOSTS" > "$ENV_FILE"
if [ -f "$SOLVER_DIR/app/service.py" ]; then
  printf 'SOLVER_PORT=%s\nSOLVE_HOSTS=%s\n' "$SOLVER_PORT" "$SOLVE_HOSTS" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

if has_systemd; then
  cat > "$UNIT" <<EOF
[Unit]
Description=film-proxy (penerus permintaan yanz.api)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/python3 $APP_DIR/proxy.py
User=nobody
Group=nogroup
NoNewPrivileges=true
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$UNIT"
  systemctl daemon-reload
  systemctl enable film-proxy >/dev/null 2>&1 || true
  systemctl restart film-proxy
  MODE="systemd (otomatis hidup lagi setelah reboot)"
else
  pkill -f "$APP_DIR/proxy.py" 2>/dev/null || true
  ( set -a; . "$ENV_FILE"; set +a; nohup python3 "$APP_DIR/proxy.py" </dev/null >/var/log/film-proxy.log 2>&1 & )
  MODE="nohup (TIDAK otomatis hidup setelah reboot; jalankan ulang skrip ini)"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp >/dev/null || true
fi

sleep 2
LOCAL="$(curl -s --max-time 5 "http://127.0.0.1:$PORT/health" || true)"
PUBLIC_IP="$(curl -4 -s --max-time 8 https://api.ipify.org || curl -4 -s --max-time 8 https://ifconfig.me || true)"
INNER_IPS="$(hostname -I 2>/dev/null || true)"

echo "== film-proxy terpasang =="
echo "  Mode        : $MODE"
echo "  Cek lokal   : ${LOCAL:-GAGAL}"
echo "  IP publik   : ${PUBLIC_IP:-tidak diketahui}"
echo "  IP di dalam : $INNER_IPS"

if [ "$LOCAL" != "ok" ]; then
  echo
  echo "======== KIRIM BAGIAN INI KE AGEN ========"
  echo "HASIL TES:$RESULT"
  echo "PROXY GAGAL JALAN. Log terakhir:"
  if has_systemd; then journalctl -u film-proxy -n 15 --no-pager 2>/dev/null || true
  else tail -n 15 /var/log/film-proxy.log 2>/dev/null || true; fi
  echo "=========================================="
  exit 1
fi

# ------------------------------------------------------------- 3. terowongan
# Banyak container murah berada di balik NAT: IP publiknya milik mesin induk,
# jadi port $PORT tidak bisa dijangkau dari luar. Terowongan keluar (cloudflared
# quick tunnel) memberi alamat https publik tanpa perlu membuka port apa pun.
TUNNEL="${TUNNEL:-auto}"
if [ "$TUNNEL" = "auto" ]; then
  TUNNEL=1
  if [ -n "$PUBLIC_IP" ]; then
    for ip in $INNER_IPS; do
      if [ "$ip" = "$PUBLIC_IP" ]; then TUNNEL=0; fi
    done
  fi
fi

stop_tunnel() {
  if has_systemd; then systemctl disable --now film-proxy-tunnel 2>/dev/null || true; fi
  pkill -f "$CF_BIN tunnel" 2>/dev/null || true
}

start_tunnel() {
  local arch
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv7l | armhf) arch=arm ;;
    i386 | i686) arch=386 ;;
    *) echo "  Arsitektur $(uname -m) tidak didukung cloudflared."; return 1 ;;
  esac
  if ! "$CF_BIN" --version >/dev/null 2>&1; then
    echo "  Mengunduh cloudflared ($arch)..."
    rm -f "$CF_BIN.tmp"
    curl -fsSL --retry 2 --max-time 240 -o "$CF_BIN.tmp" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch" \
      || { echo "  Gagal mengunduh cloudflared."; rm -f "$CF_BIN.tmp"; return 1; }
    chmod 755 "$CF_BIN.tmp" && mv -f "$CF_BIN.tmp" "$CF_BIN"
    "$CF_BIN" --version >/dev/null 2>&1 || { echo "  cloudflared tidak bisa dijalankan di mesin ini."; return 1; }
  fi

  stop_tunnel
  ( umask 022; : > "$TUNNEL_LOG" )
  if has_systemd; then
    cat > "$TUNNEL_UNIT" <<EOF
[Unit]
Description=film-proxy tunnel (cloudflared quick tunnel ke port $PORT)
After=network-online.target film-proxy.service
Wants=network-online.target

[Service]
ExecStart=$CF_BIN tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:$PORT
User=nobody
Group=nogroup
NoNewPrivileges=true
Restart=always
RestartSec=5
StandardOutput=append:$TUNNEL_LOG
StandardError=append:$TUNNEL_LOG

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "$TUNNEL_UNIT"
    systemctl daemon-reload
    systemctl enable film-proxy-tunnel >/dev/null 2>&1 || true
    systemctl restart film-proxy-tunnel
  else
    ( nohup "$CF_BIN" tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$PORT" </dev/null >>"$TUNNEL_LOG" 2>&1 & )
  fi

  echo "  Menunggu alamat terowongan..."
  TUNNEL_URL=""
  for _ in $(seq 1 40); do
    TUNNEL_URL="$(tunnel_url)"
    if [ -n "$TUNNEL_URL" ]; then break; fi
    sleep 1
  done
  if [ -z "$TUNNEL_URL" ]; then
    echo "  Terowongan tidak memberi alamat. Log terakhir:"
    tail -n 12 "$TUNNEL_LOG" 2>/dev/null || true
    return 1
  fi

  # Alamat baru butuh beberapa detik sampai bisa dipakai.
  TUNNEL_CHECK="belum terjawab (wajar bila baru dibuat; agen akan mengecek ulang)"
  for _ in $(seq 1 10); do
    sleep 3
    if [ "$(curl -s --max-time 8 "$TUNNEL_URL/health" 2>/dev/null || true)" = "ok" ]; then
      TUNNEL_CHECK="ok"
      break
    fi
  done
  return 0
}

ACCESS="langsung (port $PORT)"
OUT_URL="http://${PUBLIC_IP:-IP_PUBLIK_VPS}:$PORT"
TUNNEL_URL=""
TUNNEL_CHECK=""
KEEP_URL=""
if [ "$TUNNEL" = "1" ] && [ "${NEW_TUNNEL:-}" != "1" ] && pgrep -f "$CF_BIN tunnel" >/dev/null 2>&1; then
  KEEP_URL="$(tunnel_url)"
  if [ -n "$KEEP_URL" ] && [ "$(curl -s --max-time 10 "$KEEP_URL/health" 2>/dev/null || true)" != "ok" ]; then KEEP_URL=""; fi
fi
if [ -n "$KEEP_URL" ]; then
  ACCESS="terowongan (alamat lama masih hidup, tidak diganti)"
  OUT_URL="$KEEP_URL"
  echo
  echo "== Terowongan lama masih hidup, alamatnya tidak berubah =="
  echo "  Alamat      : $KEEP_URL"
elif [ "$TUNNEL" = "1" ]; then
  echo
  echo "== Membuka terowongan (port $PORT tidak perlu dibuka dari luar) =="
  if start_tunnel; then
    ACCESS="terowongan"
    OUT_URL="$TUNNEL_URL"
    echo "  Alamat      : $TUNNEL_URL"
    echo "  Cek alamat  : $TUNNEL_CHECK"
    echo "  Catatan     : alamat ini BERGANTI bila VPS/layanan dinyalakan ulang."
    echo "                Lihat alamat terbaru: bash install.sh url"
  else
    ACCESS="terowongan GAGAL, memakai alamat langsung"
  fi
else
  stop_tunnel
fi

echo
echo "======== KIRIM BAGIAN INI KE AGEN ========"
echo "HASIL TES:$RESULT"
echo "AKSES: $ACCESS"
echo "PROXY_URL=$OUT_URL"
echo "PROXY_KEY=$KEY"
echo "SOLVER: $SOLVER_STATE"
if [ -n "$SOLVER_TEST" ]; then echo "SOLVER TES: $SOLVER_TEST"; fi
echo "=========================================="
