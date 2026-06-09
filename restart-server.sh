#!/usr/bin/env bash
# Перезапуск локального писателя краулера (server/writer.js, порт 8787).
# Использование: ./restart-server.sh
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8787}"
LOG="server/writer.log"

# 1) убить старый процесс на порту, если есть
PIDS="$(lsof -ti:"$PORT" || true)"
if [ -n "$PIDS" ]; then
  echo "Останавливаю старый сервер (PID: $PIDS) на порту ${PORT}…"
  kill $PIDS 2>/dev/null || true
  sleep 1
  # добить, если не умер
  PIDS="$(lsof -ti:"$PORT" || true)"
  [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true
fi

# 2) запустить заново в фоне, лог в server/writer.log
echo "Запускаю server/writer.js (порт $PORT)…"
PORT="$PORT" nohup node server/writer.js > "$LOG" 2>&1 &
sleep 1
echo "Готово. PID: $!  Лог: $LOG"
echo "Проверка:  curl -s localhost:$PORT/ping || tail -n 20 $LOG"
