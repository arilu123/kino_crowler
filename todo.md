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
  - [ ] опц.: votes, rn/R, video
- [ ] Экстрактор персон `/name/{id}/` → обогащение persons (enriched=true)
- [ ] Структура для наград (ld.award) и видео-ссылок (ld.video) — сейчас deferred в raw
- [ ] Источник списка id фильмов для обхода (наполнение очереди сотнями)
- [ ] Отслеживание новинок и обновление устаревших карточек
- [ ] Косметика полей: box_world формат «+X=Y», audience хвост «…ещё N»
- [ ] Периодический просмотр новых атрибутов: `SELECT * FROM discovered_attrs WHERE status='new';`
