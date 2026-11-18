#!/usr/bin/env bash
# Perbaiki worker di satu perintah: tarik kode terbaru, buang Chromium snap, pasang Chromium
# bawaan Playwright + pustaka sistemnya, lalu uji sampai browser benar-benar bisa membuka situs.
#
# Pakai (di VPS worker):
#   curl -fsSL https://raw.githubusercontent.com/aryangantenk-dev/yanz-rest-api/main/worker/fix.sh | bash
#
# Atau dari folder worker/:
#   bash fix.sh
#
# Tidak menghapus .env, model AI, atau data lain. Aman dijalankan berulang.
set -uo pipefail

REPO_URL="${YANZ_REPO:-https://github.com/aryangantenk-dev/yanz-rest-api.git}"
BRANCHES=("${YANZ_BRANCH:-}" main)
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '   ! %s\n' "$*" >&2; }

as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else "$@"; fi
}

# 1. Cari folder worker yang sedang dipakai (systemd unit -> checkout git -> lokasi skrip).
say "1/6 Mencari folder worker"
DIR=""
if command -v systemctl >/dev/null 2>&1; then
  WD="$(systemctl show -p WorkingDirectory --value yanz-worker 2>/dev/null || true)"
  [ -n "$WD" ] && [ -f "$WD/server.py" ] && DIR="$WD"
fi
if [ -z "$DIR" ] && [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  CAND="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  [ -f "$CAND/server.py" ] && DIR="$CAND"
fi
if [ -z "$DIR" ]; then
  for c in "$PWD" "$HOME/yanz/worker" "$HOME/yanz-rest-api/worker" "$HOME/yanz" "$HOME/yanz-rest-api"; do
    [ -f "$c/server.py" ] && DIR="$c" && break
    [ -f "$c/worker/server.py" ] && DIR="$c/worker" && break
  done
fi
if [ -z "$DIR" ] || [ ! -f "$DIR/server.py" ]; then
  warn "Worker belum terpasang di mesin ini. Pasang dulu dengan:"
  echo "   curl -fsSL https://raw.githubusercontent.com/aryangantenk-dev/yanz-rest-api/main/worker/install.sh | bash"
  exit 1
fi
REPO="$(cd "$DIR/.." && pwd)"
echo "   worker: $DIR"
echo "   repo  : $REPO"

# 2. Tarik kode terbaru (tanpa menyentuh .env, .models, .data, .venv).
say "2/6 Memperbarui kode worker"
if [ -d "$REPO/.git" ]; then
  if ! command -v git >/dev/null 2>&1; then
    as_root apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git
  fi
  for b in "${BRANCHES[@]}"; do
    [ -n "$b" ] || continue
    if git -C "$REPO" fetch --depth 1 origin "$b" >/dev/null 2>&1; then
      git -C "$REPO" checkout -f FETCH_HEAD >/dev/null 2>&1 || true
      echo "   kode diperbarui dari branch $b ($(git -C "$REPO" rev-parse --short HEAD 2>/dev/null))"
      break
    fi
  done
else
  warn "Bukan checkout git; memakai kode yang sudah ada di $REPO"
fi
cd "$DIR" || exit 1

# 3. Buang jejak Chromium snap.
say "3/6 Membuang Chromium snap (biang ERR_INTERNET_DISCONNECTED)"
for cand in "$(command -v chromium 2>/dev/null || true)" "$(command -v chromium-browser 2>/dev/null || true)" "$(command -v google-chrome 2>/dev/null || true)"; do
  [ -n "$cand" ] || continue
  real="$(readlink -f "$cand" 2>/dev/null || echo "$cand")"
  case "$real$cand" in
    *snap*) warn "mengabaikan $cand -> $real (snap)";;
    *) echo "   chromium sistem non-snap: $cand";;
  esac
done
if grep -q '^CHROMIUM_PATH=.*snap' .env 2>/dev/null; then
  sed -i '/^CHROMIUM_PATH=.*snap/d' .env
  echo "   CHROMIUM_PATH snap dihapus dari .env"
fi
if command -v snap >/dev/null 2>&1 && snap list chromium >/dev/null 2>&1; then
  as_root snap remove chromium >/dev/null 2>&1 || warn "gagal menghapus snap chromium (lanjut saja)"
fi

# 4. Pastikan .venv + Chromium bawaan Playwright.
say "4/6 Menyiapkan Chromium bawaan Playwright"
if [ ! -x ".venv/bin/python" ]; then
  echo "   .venv belum ada; menjalankan install.sh lengkap..."
  bash install.sh || { warn "install.sh gagal"; exit 1; }
fi
mkdir -p .browsers
if ! grep -q '^PLAYWRIGHT_BROWSERS_PATH=' .env 2>/dev/null; then
  printf '\nPLAYWRIGHT_BROWSERS_PATH=%s\n' "$DIR/.browsers" >> .env
fi
export PLAYWRIGHT_BROWSERS_PATH="$DIR/.browsers"
echo "   mengunduh Chromium (±170 MB, sekali saja)..."
.venv/bin/playwright install chromium >/dev/null 2>&1 || .venv/bin/playwright install chromium || warn "unduhan Chromium gagal"
CHROME_BIN="$(find "$DIR/.browsers" -maxdepth 5 -type f \( -name chrome -o -name headless_shell \) 2>/dev/null | head -n 1)"
if [ -n "$CHROME_BIN" ]; then
  echo "   chromium: $CHROME_BIN"
  .venv/bin/pip install -q --no-cache-dir "playwright-captcha>=0.1.4,<0.2" 2>/dev/null || warn "playwright-captcha tidak terpasang (opsional)"
else
  warn "Chromium bawaan tidak ditemukan setelah unduhan"
fi
if command -v apt-get >/dev/null 2>&1; then
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 >/dev/null 2>&1 \
    || as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 >/dev/null 2>&1 \
    || true
fi

# 5. Nyalakan ulang worker.
say "5/6 Menyalakan ulang worker"
bash ctl.sh restart || warn "restart gagal; lihat: bash ctl.sh logs"

# 6. Uji sampai browser benar-benar bisa membuka situs.
say "6/6 Menguji browser"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]')"
PORT="${PORT:-8080}"
KEY="$(grep -E '^WORKER_KEY=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]')"
for i in $(seq 1 30); do
  curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
# Rute /v1/* hanya menerima POST; GET dijawab 405 (dulu ini yang membuat uji selalu gagal).
RESULT="$(curl -sS --max-time 120 -X POST -H "x-worker-key: ${KEY}" \
  "http://127.0.0.1:${PORT}/v1/diag?url=https://example.com" || true)"
echo "$RESULT"
if echo "$RESULT" | grep -qE '"chromium"[[:space:]]*:[[:space:]]*\{[[:space:]]*"ok"[[:space:]]*:[[:space:]]*true'; then
  printf '\n\033[32mBERES: browser bisa membuka situs.\033[0m Uji dari HP:\n'
  echo "  curl -sS \"https://www.yanzapi.my.id/api/tools/turnstile?url=https://example.com&wait=10&apikey=<KEY_PRO>\""
else
  printf '\n\033[31mMasih gagal.\033[0m Rincian dari log worker:\n'
  bash ctl.sh logs 2>/dev/null | grep -i "browser" | tail -n 10 || true
  echo
  echo "Kalau ingin melihat semuanya: bash ctl.sh logs"
fi
