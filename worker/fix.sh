#!/usr/bin/env bash
# Perbaikan worker dalam satu perintah, tahan terhadap repo yang bukan checkout git.
# Fokus: Chromium benar-benar bisa keluar jaringan di LXC/NAT VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/aryangantenk-dev/yanz-rest-api/main/worker/fix.sh | bash
#
# Tidak menghapus .env, model AI, atau data lain. Aman dijalankan berulang.
set -uo pipefail

GITHUB_RAW="https://raw.githubusercontent.com/aryangantenk-dev/yanz-rest-api/main"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '   ! %s\n' "$*" >&2; }
ok() { printf '   \033[32m%s\033[0m\n' "$*"; }

as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else "$@"; fi
}

# ---------------------------------------------------------------- 1. cari worker
say "1/6 Mencari folder worker"
DIR=""
for unit in yanz-worker worker yanz; do
  command -v systemctl >/dev/null 2>&1 || break
  WD="$(systemctl show -p WorkingDirectory --value "$unit" 2>/dev/null || true)"
  if [ -n "$WD" ] && [ -f "$WD/server.py" ]; then DIR="$WD"; break; fi
done
if [ -z "$DIR" ] && [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  C="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"; [ -f "$C/server.py" ] && DIR="$C"
fi
if [ -z "$DIR" ]; then
  for c in "$PWD" "$HOME/yanz/worker" "$HOME/yanz-rest-api/worker" "$HOME/yanz" "$HOME/yanz-rest-api"; do
    [ -f "$c/server.py" ] && DIR="$c" && break
    [ -f "$c/worker/server.py" ] && DIR="$c/worker" && break
  done
fi
if [ -z "$DIR" ] || [ ! -f "$DIR/server.py" ]; then
  warn "worker tidak ditemukan. Jalankan dari folder worker: cd ~/yanz/worker && bash fix.sh"
  exit 1
fi
cd "$DIR" || exit 1
echo "   worker: $DIR"

# ------------------------------------------------- 2. pastikan server.py terbaru
say "2/6 Memastikan server.py & fix.sh versi terbaru"
WANT="$(grep -o 'VERSION = "[^"]*"' server.py 2>/dev/null | head -n1 | cut -d'"' -f2)"
if [ -d "../.git" ] || [ -d ".git" ]; then
  GITDIR="$([ -d ".git" ] && echo . || echo ..)"
  for b in main master; do
    if git -C "$GITDIR" fetch --depth 1 origin "$b" >/dev/null 2>&1; then
      git -C "$GITDIR" checkout -f FETCH_HEAD >/dev/null 2>&1 || true
      break
    fi
  done
fi
NOW="$(grep -o 'VERSION = "[^"]*"' server.py 2>/dev/null | head -n1 | cut -d'"' -f2)"
if [ -n "$NOW" ]; then ok "worker versi $NOW"; else warn "VERSION tidak terbaca"; fi
# Kalau repo bukan checkout git (unduhan zip), ambil server.py langsung dari GitHub.
if [ "$NOW" != "1.2.3" ] && command -v curl >/dev/null 2>&1; then
  if curl -fsSL --max-time 60 "$GITHUB_RAW/worker/server.py" -o /tmp/y-server.py 2>/dev/null &&
     grep -q 'VERSION = "1.2.3"' /tmp/y-server.py; then
    cp -f server.py "server.py.bak.$(date +%s)" 2>/dev/null || true
    mv -f /tmp/y-server.py server.py
    ok "server.py diperbarui dari GitHub (1.2.3)"
  else
    warn "tidak bisa mengambil server.py dari GitHub (jaringan/DNS?). Lanjut dengan versi lokal."
  fi
fi

# ------------------------------------------------------- 3. buang Chromium snap
say "3/6 Membuang Chromium snap (biang ERR_INTERNET_DISCONNECTED)"
for cand in "$(command -v chromium 2>/dev/null || true)" "$(command -v chromium-browser 2>/dev/null || true)"; do
  [ -n "$cand" ] || continue
  real="$(readlink -f "$cand" 2>/dev/null || echo "$cand")"
  case "$real$cand" in
    *snap*) warn "abaikan $cand -> $real (snap)";;
    *) ok "chromium sistem non-snap: $cand";;
  esac
done
if grep -q '^CHROMIUM_PATH=.*snap' .env 2>/dev/null; then
  sed -i '/^CHROMIUM_PATH=.*snap/d' .env; ok "CHROMIUM_PATH snap dihapus dari .env"
fi

# ------------------------------------------- 4. Chromium bawaan + pustaka sistem
say "4/6 Menyiapkan Chromium bawaan Playwright"
[ -x ".venv/bin/python" ] || { echo "   .venv belum ada, menjalankan install.sh..."; bash install.sh || exit 1; }
mkdir -p .browsers
grep -q '^PLAYWRIGHT_BROWSERS_PATH=' .env 2>/dev/null || printf '\nPLAYWRIGHT_BROWSERS_PATH=%s\n' "$DIR/.browsers" >> .env
export PLAYWRIGHT_BROWSERS_PATH="$DIR/.browsers"
if ! find "$DIR/.browsers" -maxdepth 5 -type f \( -name chrome -o -name headless_shell \) 2>/dev/null | grep -q .; then
  echo "   mengunduh Chromium (±170 MB, sekali saja)..."
  .venv/bin/playwright install chromium >/dev/null 2>&1 || .venv/bin/playwright install chromium || warn "unduhan gagal"
fi
CHROME_BIN="$(find "$DIR/.browsers" -maxdepth 5 -type f \( -name chrome -o -name headless_shell \) 2>/dev/null | head -n1)"
[ -n "$CHROME_BIN" ] && ok "chromium: $CHROME_BIN" || warn "Chromium bawaan tidak ditemukan"
.venv/bin/pip install -q --no-cache-dir "playwright-captcha>=0.1.4,<0.2" 2>/dev/null || warn "playwright-captcha opsional gagal dipasang"
if command -v apt-get >/dev/null 2>&1; then
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 >/dev/null 2>&1 \
  || as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 >/dev/null 2>&1 || true
fi

# ------------------------------------ 5. uji browser langsung (tanpa lewat HTTP)
say "5/6 Menguji Chromium langsung dari terminal"
.venv/bin/python server.py doctor
DOCTOR=$?

# ------------------------------------------------ 6. restart + uji endpoint
say "6/6 Menyalakan ulang worker dan menguji endpoint"
bash ctl.sh restart >/dev/null 2>&1 || warn "restart gagal"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]')"; PORT="${PORT:-8080}"
KEY="$(grep -E '^WORKER_KEY=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]')"
for _ in $(seq 1 40); do curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break; sleep 1; done
ask_diag() {
  curl -sS --max-time 150 -X POST -H "x-worker-key: ${KEY}" \
    "http://127.0.0.1:${PORT}/v1/diag?url=https://example.com" 2>&1 || true
}
RESULT="$(ask_diag)"
# "sedang penuh" = antrean worker terkunci. Restart sekali lalu ulangi.
if echo "$RESULT" | grep -q "sedang penuh"; then
  warn "antrean worker terkunci; restart sekali lagi..."
  bash ctl.sh restart >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break; sleep 1; done
  RESULT="$(ask_diag)"
fi
echo "   $RESULT" | head -c 1200; echo
if [ "$DOCTOR" = "0" ] || echo "$RESULT" | grep -qE '"chromium"[[:space:]]*:[[:space:]]*\{[^}]*"ok"[[:space:]]*:[[:space:]]*true'; then
  printf '\n\033[32mBERES: Chromium bisa membuka situs.\033[0m Uji dari HP:\n'
  echo "  curl -sS \"https://www.yanzapi.my.id/api/tools/turnstile?url=https://example.com&wait=10&apikey=<KEY_PRO>\""
else
  printf '\n\033[31mChromium masih tidak bisa keluar jaringan.\033[0m\n'
  echo "Kirimkan seluruh output di atas (bagian '3' dan '5' terutama). Kalau perlu, cek juga:"
  echo "  cat /etc/resolv.conf; env | grep -i proxy; bash ctl.sh logs | tail -30"
fi
