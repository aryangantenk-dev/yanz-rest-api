#!/usr/bin/env bash
# Pengendali yanz-worker (mode langsung maupun Docker):
#   bash ctl.sh start | stop | restart | ensure | status | logs | test [fitur...]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

env_val() {
  local k="$1" def="${2:-}" v=""
  if [ -f "$DIR/.env" ]; then
    v="$(grep -E "^${k}=" "$DIR/.env" | tail -n 1 | cut -d= -f2- | sed -e 's/^[[:space:]"'"'"']*//' -e 's/[[:space:]"'"'"']*$//' || true)"
  fi
  printf '%s' "${v:-$def}"
}

PORT="$(env_val PORT 8080)"
KEY="$(env_val WORKER_KEY "")"
DATA_DIR="$(env_val DATA_DIR "$DIR/.data")"
LOG="$DATA_DIR/worker.log"
SUP_PID="$DATA_DIR/supervisor.pid"
SRV_PID="$DATA_DIR/server.pid"
STOP_FLAG="$DATA_DIR/stop"

has_systemd_unit() {
  [ -d /run/systemd/system ] && [ -f /etc/systemd/system/yanz-worker.service ]
}

has_docker_worker() {
  command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'yanz-worker'
}

as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else "$@"; fi
}

alive() {
  [ -f "$1" ] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null
}

healthy() {
  curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

wait_healthy() {
  local i
  for i in $(seq 1 45); do
    if healthy; then return 0; fi
    sleep 1
  done
  return 1
}

cmd="${1:-status}"
shift || true

# Loop pengawas internal: menyalakan ulang server.py bila mati sendiri.
if [ "$cmd" = "_loop" ]; then
  mkdir -p "$DATA_DIR"
  echo "$$" > "$SUP_PID"
  while [ ! -f "$STOP_FLAG" ]; do
    "$DIR/.venv/bin/python" "$DIR/server.py" &
    child=$!
    echo "$child" > "$SRV_PID"
    wait "$child" || true
    [ -f "$STOP_FLAG" ] && break
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] yanz-worker berhenti, menyalakan ulang dalam 2 detik..."
    sleep 2
  done
  rm -f "$SRV_PID" "$SUP_PID"
  exit 0
fi

case "$cmd" in
  start)
    if has_systemd_unit; then
      as_root systemctl start yanz-worker
      wait_healthy
      echo "yanz-worker berjalan (systemd, port ${PORT})."
      exit 0
    fi
    if [ ! -x "$DIR/.venv/bin/python" ] && has_docker_worker; then
      docker start yanz-worker >/dev/null
      wait_healthy
      echo "yanz-worker berjalan (Docker, port ${PORT})."
      exit 0
    fi
    if [ ! -x "$DIR/.venv/bin/python" ]; then
      echo "Worker belum terpasang. Jalankan dulu: bash install.sh" >&2
      exit 1
    fi
    if healthy && alive "$SUP_PID"; then
      echo "yanz-worker sudah berjalan di port ${PORT}."
      exit 0
    fi
    mkdir -p "$DATA_DIR"
    rm -f "$STOP_FLAG"
    if command -v setsid >/dev/null 2>&1; then
      setsid bash "$DIR/ctl.sh" _loop </dev/null >>"$LOG" 2>&1 &
    else
      nohup bash "$DIR/ctl.sh" _loop </dev/null >>"$LOG" 2>&1 &
    fi
    if ! wait_healthy; then
      echo "Worker belum menjawab di port ${PORT}. Log terakhir:" >&2
      tail -n 40 "$LOG" >&2 || true
      exit 1
    fi
    echo "yanz-worker berjalan di port ${PORT}."
    ;;

  stop)
    if has_systemd_unit; then
      as_root systemctl stop yanz-worker
      echo "yanz-worker dihentikan."
      exit 0
    fi
    if [ ! -x "$DIR/.venv/bin/python" ] && has_docker_worker; then
      docker stop yanz-worker >/dev/null || true
      echo "yanz-worker dihentikan."
      exit 0
    fi
    mkdir -p "$DATA_DIR"
    touch "$STOP_FLAG"
    for f in "$SRV_PID" "$SUP_PID"; do
      if alive "$f"; then kill "$(cat "$f")" 2>/dev/null || true; fi
    done
    pkill -f "$DIR/server.py" 2>/dev/null || true
    for _ in $(seq 1 10); do
      if ! healthy; then break; fi
      sleep 0.5
    done
    rm -f "$SRV_PID" "$SUP_PID" "$STOP_FLAG"
    echo "yanz-worker dihentikan."
    ;;

  restart)
    bash "$DIR/ctl.sh" stop >/dev/null 2>&1 || true
    bash "$DIR/ctl.sh" start
    ;;

  ensure)
    if healthy; then exit 0; fi
    if [ -x "$DIR/.venv/bin/python" ] && [ -f "$DIR/.env" ]; then
      bash "$DIR/ctl.sh" start >/dev/null 2>&1 || true
    fi
    ;;

  status)
    if healthy; then
      echo "Status: AKTIF di http://127.0.0.1:${PORT}"
      if [ -n "$KEY" ]; then
        curl -fsS -H "x-worker-key: ${KEY}" "http://127.0.0.1:${PORT}/health" && echo
      else
        curl -fsS "http://127.0.0.1:${PORT}/health" && echo
      fi
    else
      echo "Status: MATI (port ${PORT} tidak menjawab)"
      exit 1
    fi
    ;;

  logs)
    if has_systemd_unit; then
      exec journalctl -u yanz-worker -n 100 -f
    elif [ ! -x "$DIR/.venv/bin/python" ] && has_docker_worker; then
      exec docker logs --tail 100 -f yanz-worker
    else
      mkdir -p "$DATA_DIR"
      touch "$LOG"
      exec tail -n 100 -f "$LOG"
    fi
    ;;

  test)
    if [ -x "$DIR/.venv/bin/python" ]; then
      exec "$DIR/.venv/bin/python" "$DIR/selftest.py" "$@"
    elif has_docker_worker; then
      exec docker exec -i yanz-worker python selftest.py "$@"
    else
      echo "Worker belum terpasang. Jalankan dulu: bash install.sh" >&2
      exit 1
    fi
    ;;

  *)
    echo "Pemakaian: bash ctl.sh {start|stop|restart|status|logs|test [fitur...]}" >&2
    exit 2
    ;;
esac
