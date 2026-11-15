#!/usr/bin/env bash
# Pasang atau perbarui yanz-worker di mesin ini.
# Secara bawaan dipasang LANGSUNG tanpa Docker (hemat ruang disk < 1 GB, memanfaatkan Chromium
# sistem yang sudah ada di Instabox, dan mendaftarkan layanan systemd / pengawas latar belakang).
# Gunakan `--docker` hanya bila ingin membangun kontainer Docker terpisah di VPS berkapasitas besar.
#
# Cara pakai satu baris di terminal Instabox:
#   curl -fsSL https://raw.githubusercontent.com/aryangantenk-dev/yanz-rest-api/main/worker/install.sh | bash
#
# Atau dari folder worker/:
#   bash install.sh                  pasang / perbarui langsung tanpa Docker (bawaan)
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

free_disk_mb() {
  local p="${1:-$HOME}"
  [ -e "$p" ] || p="/"
  df -Pm "$p" 2>/dev/null | awk 'NR==2 {print $4}'
}

reclaim_docker_space_if_low() {
  local avail
  avail="$(free_disk_mb "/")"
  if [[ "${avail:-99999}" =~ ^[0-9]+$ ]] && [ "$avail" -lt 10000 ] && command -v docker >/dev/null 2>&1; then
    echo "Ruang disk tersisa ${avail} MB — membersihkan sisa cache Docker yang gagal sebelumnya..."
    as_root docker rm -f yanz-worker >/dev/null 2>&1 || true
    as_root docker system prune -af >/dev/null 2>&1 || true
    as_root docker builder prune -af >/dev/null 2>&1 || true
    rm -rf "${HOME:-/root}/.cache/pip" 2>/dev/null || true
    echo "Ruang disk sekarang: $(free_disk_mb "/") MB kosong."
  fi
}

# Bila dijalankan langsung lewat `curl ... | bash` (bukan dari berkas di folder worker/),
# gunakan checkout yang sudah ada (mis. ~/yanz) atau unduh ke ~/yanz.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -z "$SELF_DIR" ] || [ ! -f "$SELF_DIR/server.py" ] || [ ! -f "$SELF_DIR/ctl.sh" ]; then
  reclaim_docker_space_if_low
  REPO_URL="${YANZ_REPO:-https://github.com/aryangantenk-dev/yanz-rest-api.git}"

  if ! command -v git >/dev/null 2>&1; then
    echo "Memasang git..."
    as_root apt-get update -qq || true
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates curl
  fi

  # Cari checkout git yang sudah ada (jangan menghapus folder pengguna).
  TARGET_DIR=""
  if [ -n "${YANZ_DIR:-}" ]; then
    TARGET_DIR="$YANZ_DIR"
  else
    for cand in "$(git rev-parse --show-toplevel 2>/dev/null || true)" "$HOME/yanz" "$HOME/yanz-rest-api"; do
      [ -n "$cand" ] || continue
      if [ -d "$cand/.git" ]; then
        TARGET_DIR="$cand"
        break
      fi
    done
  fi

  # Branch terbaru: pakai branch pengembangan bila ada, kalau tidak `main`.
  BUMP=""
  if [ -n "$TARGET_DIR" ] && [ -d "$TARGET_DIR/.git" ]; then
    for cand in "${YANZ_BRANCH:-arena/f8aec1ff-yanz-rest-api}" "main"; do
      if git -C "$TARGET_DIR" fetch --depth 1 origin "$cand" >/dev/null 2>&1; then
        BUMP="$cand"
        break
      fi
    done
    if [ -n "$BUMP" ]; then
      echo "Memperbarui kode di $TARGET_DIR (branch $BUMP)..."
      git -C "$TARGET_DIR" checkout -f FETCH_HEAD >/dev/null 2>&1 || git -C "$TARGET_DIR" checkout -f FETCH_HEAD
    else
      echo "Tidak bisa menghubungi GitHub. Memakai kode yang sudah ada di $TARGET_DIR." >&2
    fi
  fi

  if [ -z "$TARGET_DIR" ]; then
    TARGET_DIR="$HOME/yanz"
    if [ -e "$TARGET_DIR" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]; then
      TARGET_DIR="$HOME/yanz-rest-api"
    fi
    for cand in "${YANZ_BRANCH:-arena/f8aec1ff-yanz-rest-api}" main; do
      echo "Mengunduh yanz-worker ke $TARGET_DIR (branch $cand)..."
      if git clone --depth 1 -b "$cand" "$REPO_URL" "$TARGET_DIR"; then
        break
      fi
      rm -rf "$TARGET_DIR"
    done
  fi

  if [ ! -f "$TARGET_DIR/worker/install.sh" ]; then
    echo "Gagal mendapatkan kode yanz-rest-api di $TARGET_DIR." >&2
    exit 1
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

# Bawaan: pasang langsung tanpa Docker (jauh lebih cepat & hemat ruang disk di Instabox/VPS kecil).
COMPOSE=()
if [ "$FORCE_MODE" = "docker" ]; then
  if ! detect_compose; then
    echo "Mode --docker diminta, tetapi layanan Docker tidak aktif di mesin ini." >&2
    exit 1
  fi
  RUN_MODE="docker"
else
  RUN_MODE="native"
fi

if [ "$RUN_MODE" = "native" ]; then
  reclaim_docker_space_if_low
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
DISK_MB="$(free_disk_mb "$DIR")"
DISK_MB="${DISK_MB:-8000}"
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

# Pilih Whisper `base` (~145 MB) bila RAM < 5 GB atau sisa disk < 10 GB supaya tidak kehabisan ruang.
CUR_WHISPER="$(get_env_kv WHISPER_MODEL)"
if [ -z "$CUR_WHISPER" ]; then
  if [ "$RAM_MB" -lt 5000 ] || [ "$DISK_MB" -lt 10000 ]; then
    set_env_kv WHISPER_MODEL "base"
  else
    set_env_kv WHISPER_MODEL "small"
  fi
elif [ "$CUR_WHISPER" = "small" ] && [ "$DISK_MB" -lt 8000 ] && [ ! -d "$DIR/.models/hf" ]; then
  set_env_kv WHISPER_MODEL "base"
fi
if [ "$FRESH_ENV" = 1 ] && [ "$RAM_MB" -lt 3200 ]; then
  set_env_kv MAX_JOBS "1"
fi
WHISPER_CHOICE="$(get_env_kv WHISPER_MODEL)"
PORT="$(get_env_kv PORT)"
PORT="${PORT:-8080}"

install_native() {
  echo "Mode pasang: langsung tanpa Docker (RAM ~${RAM_MB} MB, disk kosong ~${DISK_MB} MB, Whisper: ${WHISPER_CHOICE})"

  if command -v apt-get >/dev/null 2>&1; then
    echo "[1/5] Memasang paket sistem (ffmpeg, Python venv, pustaka pendukung)..."
    as_root apt-get update -qq
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl bzip2 ffmpeg python3 python3-venv python3-pip \
      libatomic1 libgomp1 libstdc++6 libgl1 libglib2.0-0 \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji
    as_root apt-get clean
  elif ! command -v ffmpeg >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    echo "ffmpeg dan python3 wajib terpasang di sistem ini." >&2
    exit 1
  fi

  echo "[2/5] Menyiapkan lingkungan Python (.venv) tanpa cache duplikat..."
  # Pilih Python >= 3.11 (dibutuhkan rembg & rapidocr terbaru).
  PYBIN=""
  for cand in "${YANZ_PYTHON:-}" python3.13 python3.12 python3.11 python3; do
    [ -n "$cand" ] || continue
    command -v "$cand" >/dev/null 2>&1 || continue
    if "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 11) else 1)' 2>/dev/null; then
      PYBIN="$cand"
      break
    fi
  done
  if [ -z "$PYBIN" ]; then
    echo "Butuh Python 3.11 atau lebih baru. Pasang dulu, misal: sudo apt install python3.11 python3.11-venv" >&2
    exit 1
  fi
  echo "      Memakai $("$PYBIN" -V 2>&1) ($PYBIN)"
  if [ -x "$DIR/.venv/bin/python" ] && ! "$DIR/.venv/bin/python" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 11) else 1)' 2>/dev/null; then
    rm -rf "$DIR/.venv"
  fi
  if [ ! -x "$DIR/.venv/bin/python" ]; then
    "$PYBIN" -m venv "$DIR/.venv"
  fi
  "$DIR/.venv/bin/pip" install -q --no-cache-dir --retries 5 --upgrade pip

  # Pasang dependensi. Bila satu paket gagal (mis. OCR belum punya roda untuk
  # versi Python di mesin ini), ulangi tanpa fitur itu supaya 9 fitur lain tetap hidup.
  if ! "$DIR/.venv/bin/pip" install --no-cache-dir --retries 5 -r "$DIR/requirements.txt"; then
    echo "Sebagian dependensi gagal dipasang. Mencoba ulang tanpa OCR (rapidocr/opencv)..."
    grep -viE '^(rapidocr|opencv-python-headless)' "$DIR/requirements.txt" > "$DIR/.requirements.noocr.txt"
    if "$DIR/.venv/bin/pip" install --no-cache-dir --retries 5 -r "$DIR/.requirements.noocr.txt"; then
      echo "Peringatan: fitur /v1/ocr tidak aktif di mesin ini; 9 fitur lain tetap berjalan." >&2
    else
      echo "Pemasangan dependensi Python gagal. Kirim log di atas ke chat Arena." >&2
      exit 1
    fi
  fi
  # rapidocr menarik opencv (versi GUI). Di server tanpa layar, ganti ke varian headless.
  if "$DIR/.venv/bin/pip" show opencv-python >/dev/null 2>&1; then
    "$DIR/.venv/bin/pip" uninstall -y -q opencv-python >/dev/null 2>&1 || true
    "$DIR/.venv/bin/pip" install -q --no-cache-dir --force-reinstall --no-deps opencv-python-headless
  fi

  echo "[3/5] Menyiapkan browser Chromium..."
  SYS_CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"
  if [ -n "$SYS_CHROME" ]; then
    echo "      Memakai Chromium sistem yang sudah terpasang ($SYS_CHROME) — hemat ~600 MB disk."
    set_env_kv CHROMIUM_PATH "$SYS_CHROME"
  elif command -v apt-get >/dev/null 2>&1; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium \
      || as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium-browser \
      || true
    as_root apt-get clean
    SYS_CHROME="$(command -v chromium || command -v chromium-browser || true)"
    if [ -n "$SYS_CHROME" ]; then
      set_env_kv CHROMIUM_PATH "$SYS_CHROME"
    else
      mkdir -p "$DIR/.browsers"
      PLAYWRIGHT_BROWSERS_PATH="$DIR/.browsers" "$DIR/.venv/bin/playwright" install --with-deps chromium
    fi
  else
    mkdir -p "$DIR/.browsers"
    PLAYWRIGHT_BROWSERS_PATH="$DIR/.browsers" "$DIR/.venv/bin/playwright" install chromium
  fi

  echo "[4/5] Mengunduh model AI (hapus latar, suara Bahasa Indonesia, Whisper ${WHISPER_CHOICE})..."
  mkdir -p "$DIR/.models/rembg" "$DIR/.models/tts" "$DIR/.models/hf" "$DIR/.data"
  export REMBG_HOME="$DIR/.models/rembg"
  export U2NET_HOME="$DIR/.models/rembg"
  export HF_HOME="$DIR/.models/hf"
  export TTS_DIR="$DIR/.models/tts"
  export WHISPER_MODEL="$WHISPER_CHOICE"

  if [ -z "$(find "$DIR/.models/rembg" -name '*.onnx' -print -quit 2>/dev/null)" ]; then
    "$DIR/.venv/bin/python" -c "from rembg import new_session; new_session('u2net')" \
      || echo "Peringatan: model hapus latar gagal diunduh; ulangi nanti dengan: bash install.sh" >&2
  fi
  if [ -z "$(find "$DIR/.models/tts" -name '*.onnx' -print -quit 2>/dev/null)" ]; then
    curl -fL --retry 3 --retry-delay 2 -sS \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-id_ID-news_tts-medium.tar.bz2 \
      | tar xj -C "$DIR/.models/tts" \
      || echo "Peringatan: model suara gagal diunduh; ulangi nanti dengan: bash install.sh" >&2
  fi
  "$DIR/.venv/bin/python" -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8')" \
    || echo "Peringatan: model Whisper gagal diunduh; ulangi nanti dengan: bash install.sh" >&2

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
  echo "Mode pasang: Docker Compose (membangun image)..."
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
  1. Buka tab "Ports" di bagian atas kanan Instabox, lalu publikasikan
     port ${PORT} (Public) dan salin alamat HTTPS-nya.
     (Cek di browser: <URL>/health harus menampilkan {"ok": true, ...})

  2. Kirim alamat URL publik tadi beserta WORKER_KEY di bawah ini ke
     chat Arena supaya langsung dipasang ke Vercel dan di-deploy ulang:

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
