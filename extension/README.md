# Kinopoisk Crawler — расширение + локальный писатель (Postgres)

Сбор данных идёт из твоего залогиненного браузера, поэтому анти-бот защита не мешает.
Данные пишутся сразу в Postgres (БД `kinopoisk`).

## Предусловия (один раз)
- Postgres запущен (Postgres.app, localhost:5432).
- Создана БД и схема:
  ```
  /Applications/Postgres.app/Contents/Versions/17/bin/psql -h localhost -U mac -d postgres -c "CREATE DATABASE kinopoisk OWNER mac;"
  /Applications/Postgres.app/Contents/Versions/17/bin/psql -h localhost -U mac -d kinopoisk -f db/schema.sql
  ```
- Установлены зависимости писателя: `cd server && npm install`.

## Как запустить

1. **Запусти писателя** (пишет в Postgres):
   ```
   node server/writer.js
   ```
   Должно появиться: `kp-crawler writer → Postgres, слушает http://localhost:8787`.
   Терминал держим открытым, пока крауллим.
   (Другая строка подключения — через env `DATABASE_URL`.)

2. **Установи расширение** (один раз):
   - Chrome → `chrome://extensions`
   - включи **Developer mode** (справа вверху)
   - **Load unpacked** → выбери папку `extension/`

3. **Крауль**: ходи по сайту. Расширение работает на **всех** страницах kinopoisk.ru.
   - Для любой разбираемой страницы (главная фильма, его подстраницы, страница персоны) её исходный
     HTML целиком сохраняется в `page_html(url, raw_html)` — страховка для офлайн-переразбора.
     **Оптимистично:** сохранение исходника и запись распарсенных данных идут ПАРАЛЛЕЛЬНО; зелёный
     «✓» показывается только если успешны ОБА. При сбое любого — страница не помечается и повторится
     на следующем тике (все записи идемпотентны). Исходник пишется один раз на url за сессию.
   - На странице фильма данные извлекаются и пишутся в БД автоматически.
   - **Панель** (правый низ): сверху — очередь из двух под-списков: «новые фильмы» (синие, из
     `link_queue`, ещё нет в БД) и «↻ Переобход — добор новых полей» (оранжевые, `critics_checked=false`)
     — кликабельные `#id — Название`, можно сразу перейти; посередине — плашка `🆕 новые атрибуты: …`,
     если впервые встретился неизвестный атрибут; снизу — статус: `✓ #id записан` / `↻ #id обновлён`.
   - На странице `/film/{id}/cast/` собирается **полный каст** (актёры с персонажами + вся
     съёмочная группа, включая дубляж) → `film_credits`, `films.full_cast_fetched=true`.
   - На `/film/{id}/dates/` — премьеры/релизы по странам → `film_dates`, `films.dates_fetched=true`.
   - На `/film/{id}/box/` (и вкладках стран `/box/<country>/`) — сборы/затраты/уикенды →
     `film_box`, `films.box_fetched=true`.
   - На `/film/{id}/studio/` — кинокомпании (производство/эффекты/дубляж/прокат) → `film_studios`
     и тех. характеристики → `film_tech`, `films.studio_fetched=true`.
   - На `/film/{id}/other/` — связанные фильмы (продолжения/спин-оффы/отсылки/упоминания/…) →
     `film_relations`, `films.other_fetched=true`.
   - На `/film/{id}/like/` — похожие фильмы (подборка) → `film_similar`, `films.like_fetched=true`;
     сами фильмы также попадают в очередь (добор новых) общим сканером ссылок.
   - На `/film/{id}/keywords/` — ключевые слова (теги) → `film_keywords`, `films.keywords_fetched=true`.
   - На `/film/{id}/awards/` — награды/премии/номинации → `film_awards`, `films.awards_fetched=true`.
   - На `/series/{id}/` — главная **сериала** (формат как у фильма) → отдельные таблицы `series`
     и `series_credits` (id-пространство сериалов и фильмов пересекается, поэтому держим раздельно).
     Ссылки на сериалы с любых страниц копятся в очередь как `kind='series'`; туда же детерминированно
     ставятся его подстраницы `page:series:cast` и `page:series:episodes` (URL выводятся из id, т.к. на
     странице сериала ссылки на них ведут в /film/-неймспейс). Всё в одной `link_queue` — обход отдельным проходом.
   - На `/series/{id}/cast/` — полный каст сериала (та же страница, что у фильма) → `series_credits`,
     `series.full_cast_fetched=true`.
   - На `/series|film/{id}/episodes/` — сезоны и эпизоды (название/оригинал/дата выхода) →
     `series_episodes`, `series.episodes_fetched=true`.
   - На `/name/{id}/` — обогащение персоны (пол, даты, место рожд., рост, профессии, жанры,
     фильмография) → колонки `persons.*`, `persons.enriched=true`.
   - На главной также снимаются рейтинг кинокритиков (мир/РФ) → `film_critics` и IMDb → `films.imdb_*`.
   - Со всех страниц собираются ссылки на фильмы, персоны и подстраницы → очередь `link_queue`.
   - Уже посещённые фильмы на страницах приглушаются (opacity).
   - В терминале писателя: `✓ <id> <название> (N персон, новый|обновлён)`.

## Консоль (window.kp)
- `kp.status()` — текущий фильм и статус записи.
- `kp.links()` — `{all, known, unvisited, persons}`: id ссылок на странице.
- `kp.go(id)` — перейти на фильм по id.
- `kp.queue()` — обновить список очереди в панели.
- `kp.recrawl()` — обновить список «добрать критиков/IMDb».
- `kp.refresh()` — перепроверить подсветку и пересобрать ссылки в очередь.

## Очередь (link_queue)
Со всех страниц собираются ссылки на фильмы/персоны. Полезные запросы:
- сколько в очереди новых фильмов: `SELECT count(*) FROM link_queue q WHERE kind='film' AND NOT EXISTS (SELECT 1 FROM films f WHERE f.id=q.id);`
- персоны в очереди (на будущее): `SELECT count(*) FROM link_queue WHERE kind='person';`

## Новые атрибуты (самообнаружение)
Любой невиданный ключ страницы (строка таблицы или ключ ld+json) попадает в `discovered_attrs`.
Посмотреть, что появилось нового:
`SELECT * FROM discovered_attrs ORDER BY first_seen DESC;`

## Что куда пишется (БД kinopoisk)
- `films` — карточка фильма (upsert при повторном заходе, `updated_at` обновляется).
- `persons` — персоны (upsert, флаг `enriched` не сбрасывается).
- `film_credits` — состав (film_id, person_id, role, ord), пересобирается на каждый заход.
- Очередь добора: `persons WHERE enriched=false`, `films WHERE full_cast_fetched=false`.

## Файлы
- `manifest.json` — MV3, content-script на `/film/*`, host-доступ к localhost:8787.
- content-script разбит на модули (грузятся по порядку, делят общий isolated-world scope;
  `content-main.js` обязан быть последним — в нём опросный цикл `tick()`):
  - `content-core.js` — состояние сессии, утилиты, разбор id/ld, парс дат, обмен с writer (`commitPage`).
  - `content-panel.js` — плавающая панель (очередь, переобход, бейдж, новые атрибуты).
  - `content-film.js` — главная фильма `/film/{id}/`: `extract()` + общий `extractFromPage()` + `send`/`schedule`.
  - `content-series.js` — главная сериала `/series/{id}/`: переиспользует `extractFromPage()` → `series`/`series_credits`.
  - `content-discover.js` — сбор ссылок (фильмы/персоны/сериалы/кинокомпании), подсветка посещённых, отправка в очередь.
  - `content-subpages.js` — `/cast/ /dates/ /box/ /studio/ /other/ /like/ /keywords/ /awards/` +
    каст сериала `/series/{id}/cast/` и эпизоды `/series|film/{id}/episodes/`.
  - `content-person.js` — `/name/{id}/` (формат Next.js).
  - `content-main.js` — консольный API `window.kp` и цикл `tick()` (точка входа).
- `background.js` — POST данных писателю (обходит CORS/CSP страницы).
- `../server/writer.js` — локальный писатель (Node + pg → Postgres): http-сервер и роутинг (точка входа).
  - `../server/db.js` — пул соединений с Postgres.
  - `../server/saves.js` — запись в БД (`saveMovie`/`saveCast`/… и самообнаружение атрибутов).
  - `../server/queue.js` — очередь/обнаружение ссылок (`queueFilms`/`discoverLinks`/`knownFilmIds`).
- `../db/schema.sql` — схема БД.

## Если не пишется
- Проверь, что писатель запущен и подключился к БД (`node server/writer.js`).
- Postgres запущен? БД `kinopoisk` и схема созданы?
- Порт 8787 занят? Поменяй `PORT` (env или в `writer.js`) и `WRITER_URL` в `background.js`.
- После правок `content-*.js`/`background.js` нажми «обновить» у расширения в `chrome://extensions`.
