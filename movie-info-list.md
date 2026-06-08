# Атрибуты фильма (главная страница)

Источник: главная страница фильма, напр. `https://www.kinopoisk.ru/film/78871/`
Снято с реального HTML живого DOM (см. WorkHistory).

⚠️ **ВАЖНО (решение 11):** `ld+json` НЕ обновляется при SPA-переходе по ссылке (остаётся от
первого открытого фильма). Поэтому извлечение **DOM-first**; `ld` используется только когда его
`url` совпадает с адресом (полная загрузка). Колонка «Источник» ниже — историческая; фактические
SPA-устойчивые якоря см. в `extension/content-*.js` (главная фильма — `content-film.js`) и таблице ниже.

Источники на странице:
- **TBL** — таблица «О фильме» `data-test-id="encyclopedic-table"` (обновляется на SPA). Основной источник.
- **DOM/микроразметка** — `h1[itemprop=name]`, `[class*=originalTitle]`, `a[itemprop=actor]`,
  `[data-tid="kp-movie-rating.rating-value"]`, `button[aria-label*="оцен"]`,
  `meta[name=description]`, `meta[property=og:image]` (всё обновляется на SPA).
- **LD** — `ld+json` (schema.org Movie). Только при полной загрузке (когда совпал с адресом).

Колонка «Якорь» — как доставать. ID персон берём из `href="/name/ID/"`.

| Поле JSON        | Описание                  | Источник | Якорь |
|------------------|---------------------------|----------|-------|
| id               | ID фильма                 | URL      | `/film/(\d+)/` |
| title            | Название (рус)            | LD       | `name` |
| titleOrig        | Оригинальное название     | LD       | `alternateName` / DOM под h1 |
| year             | Год производства          | LD / TBL | `datePublished` / row `year` |
| slogan           | Слоган                    | TBL      | row `tagline` |
| originals        | Первоисточник             | TBL      | row `originals` (напр. «DC Universe») |
| genres[]         | Жанры                     | LD / TBL | `genre` / row `genres` |
| countries[]      | Страны                    | LD / TBL | `countryOfOrigin` / row `countries` |
| duration         | Длительность, мин         | LD / TBL | `timeRequired` / row `duration` |
| ageRestriction   | Возрастной ценз           | TBL      | row `ageRestriction` |
| ratingMPAA       | Рейтинг MPAA              | LD / TBL | `contentRating` / row `ratingMPAA` |
| rating.value     | Рейтинг КП                | LD       | `aggregateRating.ratingValue` |
| rating.count     | Кол-во оценок             | LD       | `aggregateRating.ratingCount` |
| imdb.value       | Рейтинг IMDb              | DOM      | `.film-sub-rating [class*=valueSection]` («IMDb: 6.50») |
| imdb.count       | Кол-во оценок IMDb        | DOM      | `.film-sub-rating [class*=count]` |
| critics[]        | Рейтинг кинокритиков (мир/РФ) | DOM   | `[class*=criticRatingSection]` → `h3`+бар → `film_critics` |
| description      | Описание/синопсис         | LD       | `description` (раскодировать &nbsp;) |
| poster           | Ссылка на постер          | LD       | `ld.image` (если не `data:`) |
| crew.directors[] | Режиссёры {id,name}       | LD / TBL | `director[]` / row `directors` → `/name/` |
| crew.writers[]   | Сценаристы                | TBL      | row `writers` → `/name/` |
| crew.producers[] | Продюсеры                 | TBL      | row `producers` → `/name/` |
| crew.operators[] | Операторы                 | TBL      | row `operators` → `/name/` |
| crew.composers[] | Композиторы               | TBL      | row `composers` → `/name/` |
| crew.designers[] | Художники                 | TBL      | row `designers` → `/name/` |
| crew.editors[]   | Монтажёры                 | TBL      | row `filmEditors` → `/name/` |
| actors[]         | Актёры (топ с главной)    | LD / DOM | `actor[]` (10) / `/name/` в блоке каста |
| boxOffice.budget | Бюджет                    | TBL      | row `budget` |
| boxOffice.marketing | Расходы на маркетинг   | TBL      | row `marketing` |
| boxOffice.usa    | Сборы в США               | TBL      | row `usaBox` |
| boxOffice.world  | Сборы в мире              | TBL      | row `worldBox` (чистить хвост «сборы») |
| boxOffice.rus    | Сборы в России            | TBL      | row `rusBox` |
| audience         | Зрители (по странам)      | TBL      | row `audience` |
| premieres.ru     | Премьера в РФ             | TBL      | row `ruPremiere` |
| premieres.world  | Премьера в мире           | TBL      | row `worldPremieres` |
| premieres.dvd    | Релиз на DVD              | TBL      | row `dvdRelease` |
| releases.bluray  | Релиз на Blu-ray          | TBL      | row `blueRayRelease` |
| releases.digital | Цифровой релиз            | TBL      | row `digitalRelease` |
| releases.re      | Повторный прокат          | TBL      | row `reRelease` |

## raw = полный снимок страницы (защита от пропущенных атрибутов)
`films.raw` хранит весь объект экстрактора, включая:
- `_allTable` — ВСЕ строки таблицы (даже не вынесенные в колонки);
- `_ld` — весь ld+json, **кроме** постера (`image`) и встроенного бинаря (`data:`-URI).
Поэтому любой новый/пропущенный атрибут можно поднять в колонку **бэкфиллом из raw**, не заходя на страницы заново.

## Самообнаружение и триаж
Невиданный ключ (строка таблицы или ключ ld) → `discovered_attrs(status='new')`.
Решение по каждому ведём в `status`: `new` (не решено) / `promoted` (вынесен в колонку) /
`deferred` (живёт в raw, структура позже) / `ignored`.
Текущий триаж: releases* → promoted; `ld.award`, `ld.video` → deferred (в raw).

## Не храним
- **Встроенный бинарь** (`data:`-URI с base64) — вырезаем везде (в т.ч. из постера и `_ld`).
- Обычные **ссылки** хранить можно: постер (`ld.image`, колонка `poster`), трейлеры (`ld.video`, в raw).
  (Решение №6 о неудержании постера отменено: постер — это ссылка, не бинарь.)

## Подстраница «Сборы» `/film/{id}/box/` (+ вкладки стран `/box/<country>/`)
Классический формат (st.kp.yandex.net), не Next.js. Парсер: `extractBox()` в `content-subpages.js` → `/box` → `film_box`.
- **box — ПО СТРАНАМ** (в отличие от `/cast/`): каждая вкладка `.insert li` несёт детали ТОЛЬКО своей
  страны (`/box/` — США, `/box/rus/` — Россия; США на rus-странице нет, и наоборот). `tab` в БД = текст
  активной вкладки (`li.act`); разные вкладки сосуществуют (PK `film_id, tab, ord`).
  Добор остальных стран: `boxCountryPages()` кладёт `/box/<slug>/` в очередь как `page:box:<slug>`
  (по записи на страну) → доходим до каждой. Покрытие = `link_queue 'page:box:%'` vs `film_box.tab`.
- Секции — `<b>` в `td[style*="#f60"]`; каждая секция = отдельная `<table cellpadding=3>`.
  Снимаем КАЖДУЮ строку (generic key-value, как discovered_attrs) → ничего не теряем.
- Строка секции: `label` = `<b style="color:#666">…:</b>`, `value` = следующий `<h3>`;
  `pct` = второй `<h3>` с «%»; `note` = `<small>` («(% от сборов)», «(кинотеатров: …)»).
- `amount` = распарсенное число; для **дат** (`dd.mm.yyyy`, напр. дата проката) `amount=NULL`, дата в `value`.
- Секции 301: «Кассовые сборы» (США/др.страны/Россия/Общие), «Затраты» (Бюджет/Маркетинг/Итого),
  «Первый уик-энд (США)», «Прокат (США)». Флаг `films.box_fetched`.

## Подстраница «Студии» `/film/{id}/studio/`
Классический формат, без вкладок. Парсер: `extractStudio()` → `/studio`. Две части:
- **Тех. характеристики** (верх, `td[style*="tech-bg"]`) → `film_tech(film_id, ord, label, value)`,
  многозначные (пустой `<b>` = продолжение предыдущего label). Generic key-value.
- **Компании** (секции `<b>` в `td[style*="#f60"]`) → `film_studios`. Роли: production/effects/dubbing/distribution.
  ⚠️ Разные namespace: `m_act[studio]/ID/` (число), `m_act[company]/ID/` (иное id-пространство),
  `m_act[company_en]/<slug>/` (слаг) → колонки `company_kind` + `company_ref` + `company_id`(число).
  `note` (font#999999): описание (эффекты) или страна (прокат). Флаг `films.studio_fetched`.

## Подстраница «Связанные фильмы» `/film/{id}/other/`
Классический формат. Парсер: `extractOther()` → `/other` → `film_relations`.
- Секции — `td.main_line` (#f60): «Продолжение»/«Приквел»/«Ремейк»/«Спин-офф»/«Отсылки к»/
  «Спародирован в»/«Упоминается в»/«Смонтировано в»/… `relation` = сырой заголовок (типы варьируются).
- Фильм связи — `div.item`: `span.name a[/film/ID/]` (назв.+год) + `span.role` (оригинал); год из названия.
- `film_relations(film_id, relation, ord, related_id, title, title_orig, year)`, флаг `films.other_fetched`.
  Сам связанный фильм отдельно в очередь не кладём — ловится общим сканером ссылок (link_queue kind='film').

## Подстраница «Ключевые слова» `/film/{id}/keywords/`
Классический формат. Парсер: `extractKeywords()` → `/keywords` → `film_keywords`.
- `ul.keywordsList > li > span > a[/lists/m_act[keyword]/ID/]`, текст — в `data-real-keyword`.
- `film_keywords(film_id, ord, keyword_id, keyword)`, флаг `films.keywords_fetched`.

## Не на главной (→ отдельные закачки в todo)
- Полный список актёров и съёмочной группы: `/film/{id}/cast/` (на главной — только топ-10).
- Награды, связанные фильмы, факты, студии — отдельные вкладки.

## Полный перечень data-test-id строк таблицы
`year, countries, genres, tagline, directors, writers, producers, operators,
composers, designers, filmEditors, budget, usaBox, worldBox, rusBox, audience,
ruPremiere, worldPremieres, dvdRelease, ageRestriction, ratingMPAA, duration,
blueRayRelease, digitalRelease, reRelease, marketing, originals`
