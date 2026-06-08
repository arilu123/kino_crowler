# TODO проекта

Очередь «что ещё докачать» теперь в БД, не здесь:
- персоны к обогащению:  `SELECT id, name FROM persons WHERE enriched = false;`
- фильмы без полного каста: `SELECT id, title FROM films WHERE full_cast_fetched = false;`
- новые невиданные атрибуты: `SELECT * FROM discovered_attrs ORDER BY first_seen DESC;`

Здесь — задачи более высокого уровня.

## Готово
- [x] Разбор структуры страницы фильма, каталог атрибутов (movie-info-list.md)
- [x] extractor.js + проверка на живом DOM (0 расхождений)
- [x] Browser extension (extension/) + локальный писатель (server/writer.js)
- [x] Переезд на Postgres (db/schema.sql, БД kinopoisk), писатель пишет в БД
- [x] Бейдж статуса записи (ID + новый/обновлён)
- [x] Самообнаружение новых атрибутов (discovered_attrs)
- [x] Подсветка посещённых ссылок + консольный API window.kp
- [x] Очередь обнаруженных ссылок (link_queue) + панель навигации (10 новых фильмов)
- [x] Полный raw (_ld + _allTable) + триаж атрибутов (discovered_attrs.status); releases → колонки

## Дальше
- [x] Архив исходного HTML: `page_html(url, raw_html)` — перед парсингом любой разбираемой страницы
      (главная/подстраницы/персона) сохраняем исходник целиком (upsert по url). TOAST-сжатие Postgres.
- [x] Захват «веток» главной (подстраницы /film/{id}/<раздел>/) в очередь (kind='page:*')
- [ ] Парсеры подстраниц (по очереди kind='page:*'):
  - [x] cast `/film/{id}/cast/` — полный каст + вся группа → full_cast_fetched=true (роли: +voice/voice_director/translator; +character, +persons.name_orig)
  - [x] dates `/film/{id}/dates/` — все премьеры/релизы по странам (table film_dates, dates_fetched)
  - [x] box `/film/{id}/box/` — сборы детально (film_box, box_fetched; generic key-value).
        ПО СТРАНАМ: каждая вкладка = своя страна; добор остальных через очередь `page:box:<slug>`,
        парсинг каждой при заходе (`tab`=страна). Покрытие: `link_queue 'page:box:%'` vs `film_box.tab`.
  - [x] studio `/film/{id}/studio/` — компании (film_studios: роли + company_kind/ref для разных
        namespace) + тех.характеристики (film_tech, многозначные), studio_fetched
  - [x] keywords `/film/{id}/keywords/` — ключевые слова (film_keywords: id+текст), keywords_fetched
  - [x] other `/film/{id}/other/` — связанные фильмы (film_relations: типизированные рёбра film→film,
        сырой тип секции; year/title_orig), other_fetched. Связанные фильмы и так идут в link_queue.
  - [x] awards `/film/{id}/awards/` — премии/номинации (film_awards: премия+год+страна, win/nomination,
        категория, привязка к персоне; одна строка на персону), awards_fetched
  - [ ] опц.: votes, rn/R, video
- [x] Экстрактор персон `/name/{id}/` → обогащение persons (enriched=true): пол, даты рожд./смерти,
      место рожд., рост, знак зодиака, профессии[], жанры[], всего фильмов + диапазон лет, фото.
      Полный raw (_ld+_rows), самообнаружение строк → discovered_attrs source='name'.
- [ ] Структура для видео-ссылок (ld.video) — сейчас deferred в raw (награды теперь берём со страницы /awards/)
- [ ] Источник списка id фильмов для обхода (наполнение очереди сотнями)
- [ ] Отслеживание новинок и обновление устаревших карточек
- [ ] Косметика полей: box_world формат «+X=Y», audience хвост «…ещё N»
- [ ] Периодический просмотр новых атрибутов: `SELECT * FROM discovered_attrs WHERE status='new';`
