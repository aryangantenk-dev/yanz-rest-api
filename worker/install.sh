#!/usr/bin/env bash
# Pasang atau perbarui yanz-worker di mesin ini (otomatis jalan tanpa Docker di Instabox/kontainer,
# atau memakai Docker di VPS biasa bila tersedia).
#
# Cara pakai satu baris di terminal Instabox:
#   curl -fsSL https://raw.githubusercontent.com/aryangantenk-dev/yanz-rest-api/main/worker/install.sh | bash
#
# Atau dari folder worker/:
#   bash install.sh                  pasang / perbarui (kunci lama tetap dipertahankan)
#   bash install.sh --langsung       paksa pasang langsung tanpa Docker
#   bash install.sh --docker         paksa pakai Docker Compose
#   bash install.sh --ganti-kunci    buat WORKER_KEY baru (lalu perbarui di Vercel)
#   bash install.sh status|logs|restart|stop|start|test
set -euo pipefail

as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

# Bila dijalankan langsung lewat `curl ... | bash` (bukan dari berkas di folder worker/),
# unduh kode terbaru ke ~/yanz-rest-api lalu jalankan dari sana.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -z "$SELF_DIR" ] || [ ! -f "$SELF_DIR/server.py" ] || [ ! -f "$SELF_DIR/ctl.sh" ]; then
  REPO_URL="${YANZ_REPO:-https://github.com/aryangantenk-dev/yanz-rest-api.git}"
  REPO_BRANCH="${YANZ_BRANCH:-main}"
  TARGET_DIR="${YANZ_DIR:-$HOME/yanz-rest-api}"
  if ! command -v git >/dev/null 2>&1; then
    echo "Memasang git..."
    as_root apt-get update -qq
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates curl
  fi
  if [ -d "$TARGET_DIR/.git" ]; then
    echo "Memperbarui kode di $TARGET_DIR ($REPO_BRANCH)..."
    git -C "$TARGET_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    git -C "$TARGET_DIR" checkout -f FETCH_HEAD
  else
    echo "Mengunduh yanz-worker ke $TARGET_DIR ($REPO_BRANCH)..."
    rm -rf "$TARGET_DIR"
    git clone --depth 1 -b "$REPO_BRANCH" "$REPO_URL" "$TARGET_DIR"
  fi
  if [ ! -f "$TARGET_DIR/worker/ctl.sh" ] && [ "$REPO_BRANCH" = "main" ]; then
    git -C "$TARGET_DIR" fetch --depth 1 origin arena/f8aec1ff-yanz-rest-api \
      && git -C "$TARGET_DIR" checkout -f FETCH_HEAD
  fi
  exec bash "$TARGET_DIR/worker/install.sh" "$@"
fi

DIR="$SELF_DIR"
cd "$DIR"
chmod +x "$DIR/ctl.sh" "$DIR/install.sh" 2>/dev/null || true

# Teruskan subperintah pengelolaan ke ctl.sh.
case "${1:-}" in
  start|stop|restart|ensure|status|logs|test)
    exec bash "$DIR/ctl.sh" "$@"
    ;;
esac

ROTATE_KEY=0
FORCE_MODE="${MODE:-}"
for arg in "$@"; do
  case "$arg" in
    --ganti-kunci) ROTATE_KEY=1 ;;
    --langsung|--tanpa-docker|--native) FORCE_MODE="native" ;;
    --docker) FORCE_MODE="docker" ;;
    *)
      echo "Opsi tidak dikenal: $arg" >&2
      echo "Gunakan: bash install.sh [--langsung|--docker|--ganti-kunci|status|logs|restart|stop|test]" >&2
      exit 2
      ;;
  esac
done

in_container() {
  [ -f /.dockerenv ] || [ -f /run/.containerenv ] \
    || grep -qaE 'docker|lxc|containerd|kubepods|sandbox' /proc/1/cgroup 2>/dev/null \
    || [ ! -d /run/systemd/system ]
}

detect_compose() {
  COMPOSE=()
  command -v docker >/dev/null 2>&1 || return 1
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    return 1
  fi
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    COMPOSE=(sudo "${COMPOSE[@]}")
    return 0
  fi
  return 1
}

COMPOSE=()
if [ "$FORCE_MODE" = "docker" ]; then
  if ! detect_compose; then
    echo "Mode --docker diminta, tetapi layanan Docker tidak aktif di mesin ini." >&2
    echo "Jalankan tanpa --docker agar dipasang langsung (cocok untuk Instabox)." >&2
    exit 1
  fi
  RUN_MODE="docker"
elif [ "$FORCE_MODE" = "native" ]; then
  RUN_MODE="native"
elif in_container; then
  RUN_MODE="native"
elif detect_compose; then
  RUN_MODE="docker"
else
  RUN_MODE="native"
fi

avail_ram_mb() {
  local host_kb=4194304 host_mb cg_bytes="" f val
  if [ -r /proc/meminfo ]; then
    host_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  fi
  host_mb=$(( ${host_kb:-4194304} / 1024 ))
  for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
    if [ -r "$f" ]; then
      val="$(cat "$f" 2>/dev/null || true)"
      if [[ "$val" =~ ^[0-9]+$ ]] && [ "$val" -gt 0 ] && [ "$val" -lt 1099511627776 ]; then
        cg_bytes="$val"
        break
      fi
    fi
  done
  if [ -n "$cg_bytes" ]; then
    local cg_mb=$(( cg_bytes / 1024 / 1024 ))
    if [ "$cg_mb" -gt 0 ] && [ "$cg_mb" -lt "$host_mb" ]; then
      echo "$cg_mb"
      return
    fi
  fi
  echo "$host_mb"
}

new_key() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48; }

set_env_kv() {
  local k="$1" v="$2"
  if grep -Eq "^${k}=" .env; then
    sed -i "s|^${k}=.*|${k}=${v}|" .env
  else
    printf '\n%s=%s\n' "$k" "$v" >> .env
  fi
}

get_env_kv() {
  grep -E "^${1}=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]"'"'" || true
}

RAM_MB="$(avail_ram_mb)"
FRESH_ENV=0
if [ ! -f .env ]; then
  cp .env.example .env
  FRESH_ENV=1
  PresetKey="${WORKER_KEY:-}"
  if [ "${#PresetKey}" -ge 24 ]; then
    set_env_kv WORKER_KEY "$PresetKey"
  else
    set_env_kv WORKER_KEY "$(new_key)"
  fi
  chmod 600 .env
  echo "Kunci baru dibuat di worker/.env"
elif [ "$ROTATE_KEY" = 1 ]; then
  set_env_kv WORKER_KEY "$(new_key)"
  echo "Kunci diganti. Perbarui juga WORKER_KEY di Vercel, lalu deploy ulang."
elif ! grep -Eq '^WORKER_KEY=.{24,}' .env; then
  set_env_kv WORKER_KEY "$(new_key)"
  echo "WORKER_KEY di worker/.env kosong, diisi kunci baru."
fi

# Sesuaikan ukuran model Whisper & jumlah pekerjaan serentak dengan kapasitas RAM mesin.
CUR_WHISPER="$(get_env_kv WHISPER_MODEL)"
if [ -z "$CUR_WHISPER" ]; then
  if [ "$RAM_MB" -lt 5000 ]; then
    set_env_kv WHISPER_MODEL "base"
  else
    set_env_kv WHISPER_MODEL "small"
  fi
fi
if [ "$FRESH_ENV" = 1 ] && [ "$RAM_MB" -lt 3200 ]; then
  set_env_kv MAX_JOBS "1"
fi
WHISPER_CHOICE="$(get_env_kv WHISPER_MODEL)"
PORT="$(get_env_kv PORT)"
PORT="${PORT:-8080}"

install_native() {
  echo "Mode pasang: langsung tanpa Docker (RAM terdeteksi ~${RAM_MB} MB, Whisper: ${WHISPER_CHOICE})"

  if command -v apt-get >/dev/null 2>&1; then
    echo "[1/5] Memasang paket sistem (ffmpeg, Python venv, font)..."
    as_root apt-get update -qq
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl bzip2 ffmpeg python3 python3-venv python3-pip \
      libgl1 libglib2.0-0 fonts-liberation fonts-noto-core fonts-noto-color-emoji
  elif ! command -v ffmpeg >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    echo "ffmpeg dan python3 wajib terpasang di sistem ini." >&2
    exit 1
  fi

  echo "[2/5] Menyiapkan lingkungan Python (.venv) & pustaka..."
  if [ ! -x "$DIR/.venv/bin/python" ]; then
    python3 -m venv "$DIR/.venv"
  fi
  "$DIR/.venv/bin/pip" install -q --upgrade pip
  "$DIR/.venv/bin/pip" install -q -r "$DIR/requirements.txt"
  "$DIR/.venv/bin/pip" uninstall -y -q opencv-python >/dev/null 2>&1 || true
  "$DIR/.venv/bin/pip" install -q --force-reinstall --no-deps opencv-python-headless

  echo "[3/5] Memasang browser Chromium untuk tangkapan layar & PDF..."
  mkdir -p "$DIR/.browsers"
  if [ "$(id -u)" = "0" ]; then
    PLAYWRIGHT_BROWSERS_PATH="$DIR/.browsers" "$DIR/.venv/bin/playwright" install --with-deps chromium || {
      apt-get install -y --no-install-recommends chromium || apt-get install -y --no-install-recommends chromium-browser || true
      PLAYWRIGHT_BROWSERS_PATH="$DIR/.browsers" "$DIR/.venv/bin/playwright" install chromium || true
    }
  else
    if command -v sudo >/dev/null 2>&1; then
      sudo env PLAYWRIGHT_BROWSERS_PATH="$DIR/.browsers" "$DIR/.venv/bin/playwright" install --with-deps chromium || {
        sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium \
          || sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium-browser || true
        PLAYWRIGHT_BROWSERS_PATH="$DIR/.browsers" "$DIR/.venv/bin/playwright" install chromium || true
      }
      sudo chown -R "$(id -u):$(id -g)" "$DIR/.browsers" || true
    else
      PLAYWRIGHT_BROWSERS_PATH="$DIR/.browsers" "$DIR/.venv/bin/playwright" install chromium
    fi
  fi

  echo "[4/5] Mengunduh model AI (hapus latar, suara Bahasa Indonesia, Whisper ${WHISPER_CHOICE})..."
  mkdir -p "$DIR/.models/rembg" "$DIR/.models/tts" "$DIR/.models/hf" "$DIR/.data"
  export REMBG_HOME="$DIR/.models/rembg"
  export U2NET_HOME="$DIR/.models/rembg"
  export HF_HOME="$DIR/.models/hf"
  export TTS_DIR="$DIR/.models/tts"
  export WHISPER_MODEL="$WHISPER_CHOICE"

  if [ -z "$(find "$DIR/.models/rembg" -name '*.onnx' -print -quit 2>/dev/null)" ]; then
    "$DIR/.venv/bin/python" -c "from rembg import new_session; new_session('u2net')"
  fi
  if [ -z "$(find "$DIR/.models/tts" -name '*.onnx' -print -quit 2>/dev/null)" ]; then
    curl -fL --retry 3 --retry-delay 2 -sS \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-id_ID-news_tts-medium.tar.bz2 \
      | tar xj -C "$DIR/.models/tts"
  fi
  "$DIR/.venv/bin/python" -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8')"

  echo "[5/5] Menyalakan yanz-worker di latar belakang (port ${PORT})..."
  if [ -d /run/systemd/system ] && ( [ "$(id -u)" = "0" ] || command -v sudo >/dev/null 2>&1 ); then
    UNIT_USER="$(id -un)"
    as_root tee /etc/systemd/system/yanz-worker.service >/dev/null <<UNIT
[Unit]
Description=yanz-worker (pendamping yanz.api)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${UNIT_USER}
WorkingDirectory=${DIR}
ExecStart=${DIR}/.venv/bin/python ${DIR}/server.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
    as_root systemctl daemon-reload
    as_root systemctl enable yanz-worker >/dev/null 2>&1 || true
    as_root systemctl restart yanz-worker
    bash "$DIR/ctl.sh" status >/dev/null
  else
    bash "$DIR/ctl.sh" restart
    # Di kontainer tanpa systemd (mis. Instabox), pastikan worker menyala lagi saat terminal dibuka setelah mesin dijeda.
    if [ -n "${HOME:-}" ] && [ -d "${HOME:-}" ]; then
      RC="$HOME/.bashrc"
      touch "$RC"
      sed -i '/# yanz-worker-autostart$/d' "$RC" 2>/dev/null || true
      printf '[ -x "%s/ctl.sh" ] && "%s/ctl.sh" ensure >/dev/null 2>&1 || true # yanz-worker-autostart\n' "$DIR" "$DIR" >> "$RC"
    fi
  fi

  echo
  echo "Menguji semua fitur (1 sampai 3 menit)..."
  bash "$DIR/ctl.sh" test || echo "Catatan: ada fitur yang belum lulus uji di atas. Lihat log dengan: bash ctl.sh logs"
}

install_docker() {
  echo "Mode pasang: Docker Compose (membangun image, pertama kali 10 sampai 20 menit)..."
  "${COMPOSE[@]}" up -d --build

  echo "Menunggu worker siap..."
  ready=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  if [ "$ready" != 1 ]; then
    echo "Worker belum menjawab di port ${PORT}. Lihat lognya: ${COMPOSE[*]} logs --tail 50 worker" >&2
    exit 1
  fi

  echo
  echo "Menguji semua fitur (1 sampai 3 menit)..."
  "${COMPOSE[@]}" exec -T worker python selftest.py || echo "Ada fitur yang gagal. Lihat log dengan: ${COMPOSE[*]} logs --tail 80 worker"
}

if [ "$RUN_MODE" = "docker" ]; then
  install_docker
else
  install_native
fi

# Coba tebak alamat publik Instabox bila ID mesin terlihat dari variabel lingkungan.
PUBLIC_HINT="https://${PORT}-<id-mesin>.instabox.tech"
for cand in "${INSTABOX_URL:-}" "${INSTABOX_HOST:-}" "${SANDBOX_HOST:-}"; do
  if [ -n "$cand" ]; then
    PUBLIC_HINT="$cand"
    break
  fi
done
if [ "$PUBLIC_HINT" = "https://${PORT}-<id-mesin>.instabox.tech" ] && [ -n "${INSTABOX_ID:-}" ]; then
  PUBLIC_HINT="https://${PORT}-${INSTABOX_ID}.instabox.tech"
fi

key="$(get_env_kv WORKER_KEY)"
cat <<MSG

=====================================================================
yanz-worker sudah berjalan di port ${PORT}!

Langkah berikutnya:
  1. Buka port ${PORT} sebagai URL publik (Public) di dashboard Instabox.
     Alamatnya berbentuk: ${PUBLIC_HINT}
     (Cek di browser: <URL>/health harus menampilkan {"ok": true, ...})

  2. Pasang dua nilai ini ke Vercel (atau kirim keduanya ke chat Arena
     supaya langsung dipasang dan di-deploy ulang otomatis):

       WORKER_URL = ${PUBLIC_HINT}
       WORKER_KEY = ${key}

Perintah berguna di folder ${DIR}:
  bash ctl.sh status     cek status & sisa disk
  bash ctl.sh logs       lihat log berjalan
  bash ctl.sh restart    nyalakan ulang worker
  bash ctl.sh test       uji ulang ke-10 fitur

Kunci di atas rahasia: jangan dibagikan di tempat umum.
=====================================================================
MSG
