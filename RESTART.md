# Перезапуск сервера

Сервер — это локальный писатель краулера `server/writer.js` (Node, порт **8787**, пишет в Postgres БД `kinopoisk`).

## Быстро (одной командой)

```bash
./restart-server.sh
```

Скрипт сам убивает старый процесс на порту 8787 и запускает заново в фоне (лог → `server/writer.log`).

## Вручную

```bash
# 1) остановить старый процесс на порту 8787
kill $(lsof -ti:8787)

# 2) запустить заново (из корня проекта)
node server/writer.js
# или в фоне с логом:
PORT=8787 nohup node server/writer.js > server/writer.log 2>&1 &
```

## Проверка

```bash
lsof -ti:8787              # есть PID → сервер слушает порт
tail -n 20 server/writer.log
```

> Порт можно переопределить переменной `PORT`, напр. `PORT=9000 ./restart-server.sh`.
