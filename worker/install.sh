#!/usr/bin/env bash
# Pasang atau perbarui yanz-worker di mesin ini. Jalankan dari folder worker:
#   bash install.sh
# Aman dijalankan berulang: kunci yang sudah ada tidak diganti.
#   bash install.sh --ganti-kunci   membuat kunci baru (lalu perbarui WORKER_KEY di Vercel)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker belum terpasang di mesin ini. Pasang dulu: https://docs.docker.com/engine/install/" >&2
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose belum terpasang." >&2
  exit 1
fi
# Tanpa hak akses ke Docker, ulangi lewat sudo.
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    COMPOSE=(sudo "${COMPOSE[@]}")
  else
    echo "Docker tidak bisa diakses. Pastikan layanan Docker berjalan (sudo systemctl start docker) dan akunmu boleh memakainya." >&2
    exit 1
  fi
fi

new_key() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48; }

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^WORKER_KEY=.*|WORKER_KEY=$(new_key)|" .env
  chmod 600 .env
  echo "Kunci baru dibuat di worker/.env"
elif [ "${1:-}" = "--ganti-kunci" ]; then
  sed -i "s|^WORKER_KEY=.*|WORKER_KEY=$(new_key)|" .env
  echo "Kunci diganti. Perbarui juga WORKER_KEY di Vercel, lalu deploy ulang."
elif ! grep -Eq '^WORKER_KEY=.{24,}' .env; then
  sed -i "s|^WORKER_KEY=.*|WORKER_KEY=$(new_key)|" .env
  echo "WORKER_KEY di worker/.env kosong, diisi kunci baru."
fi

echo "Membangun image (pertama kali 10 sampai 20 menit: mengunduh Chromium dan model)..."
"${COMPOSE[@]}" up -d --build

echo "Menunggu worker siap..."
ready=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "Worker belum menjawab di port 8080. Lihat lognya: ${COMPOSE[*]} logs --tail 50 worker" >&2
  exit 1
fi

echo
echo "Menguji semua fitur (1 sampai 3 menit)..."
"${COMPOSE[@]}" exec -T worker python selftest.py || echo "Ada fitur yang gagal. Kirim keluaran di atas ke pembuat worker ini."

key=$(grep -E '^WORKER_KEY=' .env | cut -d= -f2-)
cat <<MSG

=====================================================================
Worker berjalan di port 8080.

Langkah berikutnya:
  1. Buka port 8080 sebagai URL publik di Instabox (dashboard atau CLI).
     URL-nya berbentuk https://8080-<id-mesin>.instabox.tech
  2. Isi dua variabel di Vercel (Settings > Environment Variables):
       WORKER_URL = URL publik dari langkah 1
       WORKER_KEY = ${key}
  3. Deploy ulang proyek di Vercel.

Kunci di atas rahasia: jangan dibagikan di tempat umum.
=====================================================================
MSG
