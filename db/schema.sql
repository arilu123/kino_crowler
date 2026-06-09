-- Kinopoisk crawler — схема БД (Postgres). Прагматичная нормализация.
-- Применить:  psql -h localhost -U mac -d kinopoisk -f db/schema.sql

CREATE TABLE IF NOT EXISTS films (
  id                bigint PRIMARY KEY,            -- id фильма на Кинопоиске
  title             text,
  title_orig        text,
  year              int,
  slogan            text,
  originals         text,                          -- «Первоисточник» (на чём основан фильм), напр. «DC Universe»
  genres            text[],
  countries         text[],
  duration          int,                           -- минуты
  age_restriction   text,
  rating_mpaa       text,
  rating_value      numeric,                       -- рейтинг Кинопоиска
  rating_count      int,
  imdb_value        numeric,                       -- рейтинг IMDb (.film-sub-rating)
  imdb_count        int,
  description       text,
  poster            text,                          -- ССЫЛКА на постер (не бинарь); data:-URI не храним
  box_budget        text,
  box_marketing     text,
  box_usa           text,
  box_world         text,
  box_rus           text,
  audience          text,
  premiere_ru       text,
  premiere_world    text,
  premiere_dvd      text,
  release_bluray    text,
  release_digital   text,
  re_release        text,
  source_url        text,
  raw               jsonb,                         -- сырой объект экстрактора (страховка)
  full_cast_fetched boolean NOT NULL DEFAULT false,-- /film/{id}/cast/ ещё не разбирали
  dates_fetched     boolean NOT NULL DEFAULT false,-- /film/{id}/dates/ ещё не разбирали
  box_fetched       boolean NOT NULL DEFAULT false,-- /film/{id}/box/ ещё не разбирали
  studio_fetched    boolean NOT NULL DEFAULT false,-- /film/{id}/studio/ ещё не разбирали
  other_fetched     boolean NOT NULL DEFAULT false,-- /film/{id}/other/ (связанные фильмы) ещё не разбирали
  like_fetched      boolean NOT NULL DEFAULT false,-- /film/{id}/like/ (похожие фильмы) ещё не разбирали
  keywords_fetched  boolean NOT NULL DEFAULT false,-- /film/{id}/keywords/ ещё не разбирали
  awards_fetched    boolean NOT NULL DEFAULT false,-- /film/{id}/awards/ (награды/номинации) ещё не разбирали
  critics_checked   boolean NOT NULL DEFAULT false,-- главную пересняли после ввода критиков/IMDb (реш. 24)
  crawled_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS persons (
  id          bigint PRIMARY KEY,                  -- id персоны на Кинопоиске (/name/{id}/)
  name        text,
  name_orig   text,                                -- оригинальное имя (со страницы каста/персоны)
  -- обогащение со страницы /name/{id}/ (решение 26):
  gender       text,         -- male|female (из ld.gender)
  birth_date   date,         -- дата рождения
  death_date   date,         -- дата смерти (если есть)
  birth_place  text,         -- место рождения (город, регион, страна)
  height_cm    int,          -- рост в см (из «1.83 м»)
  zodiac       text,         -- знак зодиака
  professions  text[],       -- профессии (Актер, Продюсер, …) = ld.jobTitle / строка «Карьера»
  genres       text[],       -- основные жанры (строка «Жанры»)
  films_total  int,          -- всего фильмов (строка «Всего фильмов»)
  career_start int,          -- первый год фильмографии
  career_end   int,          -- последний год фильмографии
  photo        text,         -- ссылка на фото (CDN), без data:-бинаря
  source_url   text,         -- /name/{id}/
  enriched    boolean NOT NULL DEFAULT false,      -- страница персоны ещё не разобрана (это и есть очередь)
  raw         jsonb,                               -- полный снимок: _ld (sanitized) + _rows (все строки)
  crawled_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- фильмография персоны по профессиям (меню /name/{id}/, блок #person-filmography-block):
-- role — базовая профессия (Актер, Продюсер, Сценарист, …); subrole — уточнение после «:»
-- (играет самого себя, в титрах не указан, …) или NULL; films_count — число фильмов в (под)роли.
-- Счётчики самостоятельны и НЕ обязаны сходиться с persons.films_total (камео/документалки и т.п.).
CREATE TABLE IF NOT EXISTS person_filmography (
  person_id   bigint NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  ord         int NOT NULL,
  role        text,
  subrole     text,
  films_count int,
  label       text,                                  -- исходная подпись кнопки целиком
  PRIMARY KEY (person_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_filmography_person ON person_filmography(person_id);

-- СЕРИАЛЫ (/series/{id}/). ОТДЕЛЬНОЕ id-пространство — на Кинопоиске id сериала и фильма могут
-- совпадать численно (одна и та же цифра открывается и как /film/N/, и как /series/N/), поэтому
-- держим их в отдельной таблице, а НЕ в films. Страница сериала — тот же Next.js-формат, что и
-- главная фильма (encyclopedic-table, ld @type=TVSeries), поэтому набор колонок зеркалит films.
-- Критики/IMDb-разбивка и подстраницы (cast/dates/…) — позже; пока всё сырьё в raw (страховка).
CREATE TABLE IF NOT EXISTS series (
  id                bigint PRIMARY KEY,
  title             text,
  title_orig        text,
  year              int,                           -- год начала (из «Год»/ld)
  slogan            text,
  originals         text,
  genres            text[],
  countries         text[],
  duration          int,                           -- минуты (серии)
  age_restriction   text,
  rating_mpaa       text,
  rating_value      numeric,
  rating_count      int,
  imdb_value        numeric,
  imdb_count        int,
  description       text,
  poster            text,
  box_budget        text,
  box_marketing     text,
  box_usa           text,
  box_world         text,
  box_rus           text,
  audience          text,
  premiere_ru       text,
  premiere_world    text,
  premiere_dvd      text,
  release_bluray    text,
  release_digital   text,
  re_release        text,
  source_url        text,
  raw               jsonb,
  full_cast_fetched boolean NOT NULL DEFAULT false, -- /series/{id}/cast/ ещё не разбирали
  episodes_fetched  boolean NOT NULL DEFAULT false, -- /series/{id}/episodes/ ещё не разбирали
  crawled_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- эпизоды сериала со страницы /series/{id}/episodes/ (классическая вёрстка, общая для /film/ и
-- /series/ — один id даёт одну и ту же страницу). Сезоны размечены `<a name="sN">` + h1.moviename-big
-- «Сезон N»; эпизод — span «Эпизод N» + h1.moviename-big>b (рус. название) + span.episodesOriginalName
-- (оригинал) + дата выхода (рус. текст «25 февраля 2006», справа в строке).
CREATE TABLE IF NOT EXISTS series_episodes (
  series_id     bigint NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season        int    NOT NULL,
  episode       int    NOT NULL,         -- номер эпизода в сезоне (из «Эпизод N»)
  ord           int    NOT NULL,         -- сквозной порядок на странице
  title         text,                    -- название эпизода (рус.)
  title_orig    text,                    -- оригинальное название (span.episodesOriginalName)
  air_date      date,                    -- дата выхода (распарсенная; NULL если без полной даты)
  air_date_text text,                    -- сырьё как на странице
  PRIMARY KEY (series_id, season, episode)
);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON series_episodes(series_id);

-- состав сериала (роли как у film_credits). Отдельная таблица из-за отдельного id-пространства.
CREATE TABLE IF NOT EXISTS series_credits (
  series_id  bigint NOT NULL REFERENCES series(id)  ON DELETE CASCADE,
  person_id  bigint NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role       text   NOT NULL,
  ord        int,
  character  text,
  PRIMARY KEY (series_id, person_id, role)
);
CREATE INDEX IF NOT EXISTS idx_series_credits_person ON series_credits(person_id);
CREATE INDEX IF NOT EXISTS idx_series_genres ON series USING gin(genres);

-- роли: directors|writers|producers|operators|composers|designers|editors|actor
CREATE TABLE IF NOT EXISTS film_credits (
  film_id    bigint NOT NULL REFERENCES films(id)   ON DELETE CASCADE,
  person_id  bigint NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role       text   NOT NULL,
  ord        int,                                   -- порядок в списке на странице
  character  text,                                  -- персонаж (актёры) / примечание (со страницы каста)
  PRIMARY KEY (film_id, person_id, role)
);

-- даты со страницы /film/{id}/dates/ (премьеры/релизы по странам, разные типы)
CREATE TABLE IF NOT EXISTS film_dates (
  film_id    bigint NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  ord        int    NOT NULL,           -- порядок на странице
  date_text  text,                      -- как на сайте: «24 марта 1999»
  date       date,                      -- распарсенная (NULL, если без дня/месяца)
  country_id int,
  country    text,
  type       text,                      -- '' = театральная премьера; иначе «Премьера на DVD», «Цифровой релиз»…
  note       text,                      -- доп.: зрители/прокатчик
  PRIMARY KEY (film_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_dates_film ON film_dates(film_id);

-- сборы со страницы /film/{id}/box/ (+ вкладки стран /box/<country>/).
-- Generic key-value (как discovered_attrs): храним КАЖДУЮ строку секции, ничего не теряем.
-- section — заголовок секции на странице («Кассовые сборы», «Затраты», «Первый уик-энд (США)»,
-- «Прокат (США)», …); label — подпись строки; value — сырьё; amount/pct — распарсенное.
-- tab — активная вкладка страны (для 301: «США» на /box/, «Россия» на /box/rus/).
CREATE TABLE IF NOT EXISTS film_box (
  film_id    bigint NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  tab        text   NOT NULL DEFAULT 'США',   -- активная вкладка страны на странице box
  ord        int    NOT NULL,                 -- порядок строки в пределах (film,tab)
  section    text,                            -- заголовок секции
  label      text,                            -- подпись строки («В США», «Бюджет», …)
  value      text,                            -- сырьё как на сайте («$171 479 930», «31.03.1999»)
  amount     bigint,                          -- распарсенное число (NULL для дат/нечисел)
  currency   text,                            -- '$' если денежное
  pct        numeric,                         -- доля в процентах (37, 67.7), если указана
  note       text,                            -- доп. в строке («(% от сборов)», «(кинотеатров: …)»)
  PRIMARY KEY (film_id, tab, ord)
);
CREATE INDEX IF NOT EXISTS idx_box_film ON film_box(film_id);

-- компании со страницы /film/{id}/studio/ (секции «Производство»/«Спецэффекты»/
-- «Студия дубляжа»/«Прокат»/…). id компании — из /lists/m_act[studio]/ID/.
CREATE TABLE IF NOT EXISTS film_studios (
  film_id      bigint NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  role         text   NOT NULL, -- production|effects|dubbing|distribution|<сырой заголовок>
  ord          int    NOT NULL, -- порядок в пределах (film,role)
  company_kind text,            -- namespace ссылки: studio|company|company_en (разные id-пространства!)
  company_id   bigint,          -- числовой id (NULL для company_en — там слаг)
  company_ref  text,            -- сырой идентификатор: число или слаг («warnerbros»)
  name         text,
  note         text,            -- доп.: описание («animatronic prosthetics») или страна («Россия») — зависит от роли
  PRIMARY KEY (film_id, role, ord)
);
CREATE INDEX IF NOT EXISTS idx_studios_film ON film_studios(film_id);
CREATE INDEX IF NOT EXISTS idx_studios_company ON film_studios(company_id);

-- технические характеристики со страницы /film/{id}/studio/ (верхний блок).
-- Generic key-value, многозначные (Камера/Формат… повторяют label). Триаж/колонки — потом.
CREATE TABLE IF NOT EXISTS film_tech (
  film_id bigint NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  ord     int    NOT NULL,
  label   text,    -- «Производство», «Съёмки», «Формат изображения», «Камера», «Язык»…
  value   text,
  PRIMARY KEY (film_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_tech_film ON film_tech(film_id);

-- связанные фильмы со страницы /film/{id}/other/ (типизированные рёбра film→film).
-- relation — сырой заголовок секции («Продолжение», «Приквел», «Ремейк», «Спин-офф», «Отсылки к»,
-- «Спародирован в», «Упоминается в», «Смонтировано в», …); типы варьируются, нормализуем потом.
-- Сам связанный фильм попадает в link_queue общим сканером ссылок — тут только типизированное ребро.
CREATE TABLE IF NOT EXISTS film_relations (
  film_id     bigint NOT NULL REFERENCES films(id) ON DELETE CASCADE,  -- исходный фильм
  relation    text   NOT NULL,   -- тип связи (сырой заголовок секции)
  ord         int    NOT NULL,   -- порядок в пределах (film,relation)
  related_id  bigint,            -- id связанного фильма
  title       text,              -- название связанного (с годом/квалификатором, как на странице)
  title_orig  text,              -- оригинальное название (span.role)
  year        int,               -- год (распарсен из названия)
  PRIMARY KEY (film_id, relation, ord)
);
CREATE INDEX IF NOT EXISTS idx_relations_film ON film_relations(film_id);
CREATE INDEX IF NOT EXISTS idx_relations_related ON film_relations(related_id);

-- похожие фильмы со страницы /film/{id}/like/ («Похожие фильмы» — редакторско-алгоритмическая
-- подборка, БЕЗ типизации). Плоский упорядоченный список рёбер film→film. Сам похожий фильм
-- попадает в link_queue общим сканером ссылок (так добираем новые фильмы в очередь) — здесь
-- храним само ребро «похож» + название/год для удобства. Отдельно от film_relations: там
-- типизированные сюжетные связи (сиквел/ремейк/…), тут — ненаправленная «похожесть».
CREATE TABLE IF NOT EXISTS film_similar (
  film_id     bigint NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  ord         int    NOT NULL,   -- порядок на странице (релевантность по версии Сайта)
  similar_id  bigint,            -- id похожего фильма
  title       text,              -- RU-название (a.all в строке .ten_items)
  title_orig  text,              -- оригинальное название (из span «Orig, (YYYY) …»)
  year        int,               -- год (распарсен из span/alt постера)
  PRIMARY KEY (film_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_similar_film ON film_similar(film_id);
CREATE INDEX IF NOT EXISTS idx_similar_similar ON film_similar(similar_id);

-- ключевые слова со страницы /film/{id}/keywords/ (теги). id — из /lists/m_act[keyword]/ID/.
CREATE TABLE IF NOT EXISTS film_keywords (
  film_id    bigint NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  ord        int    NOT NULL,
  keyword_id bigint,            -- id ключевого слова (m_act[keyword]/ID/)
  keyword    text,              -- текст (из data-real-keyword)
  PRIMARY KEY (film_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_keywords_film ON film_keywords(film_id);
CREATE INDEX IF NOT EXISTS idx_keywords_kid  ON film_keywords(keyword_id);

-- награды/премии/номинации со страницы /film/{id}/awards/ (реш. 25).
-- Каждый блок-таблица = одна премия за год (заголовок `/awards/<slug>/<year>/`, флаг страны в фоне).
-- Внутри секции «Победитель» (result=win) и «Номинации» (result=nomination), в них список
-- номинаций (категорий). Категория может быть привязана к персоне(ам) — одна строка на персону
-- (категория без персон → одна строка с person_id=NULL).
CREATE TABLE IF NOT EXISTS film_awards (
  film_id     bigint NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  ord         int    NOT NULL,        -- порядок в пределах фильма (как на странице)
  award_slug  text,                   -- слаг премии (/awards/<slug>/<year>/)
  award_name  text,                   -- название премии (Оскар, Премия канала «MTV», …)
  year        int,                    -- год церемонии
  country     text,                   -- код страны из флага в фоне (us, gb, …)
  result      text,                   -- win | nomination
  category    text,                   -- номинация/категория (Лучший звук)
  nom_id      text,                   -- якорь #nomNNN на странице премии
  person_id   bigint,                 -- связанная персона (если указана)
  person_name text,
  PRIMARY KEY (film_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_awards_film ON film_awards(film_id);
CREATE INDEX IF NOT EXISTS idx_awards_person ON film_awards(person_id);

-- рейтинг кинокритиков с главной страницы (блок criticRatingSection): мир + РФ.
-- scope: world («Рейтинг кинокритиков в мире») | ru («В России») | <сырой label>.
-- pct — % положительных; positive/negative — числа рецензий; avg — средняя оценка (если есть).
CREATE TABLE IF NOT EXISTS film_critics (
  film_id   bigint NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  scope     text   NOT NULL,        -- world | ru | <сырой заголовок>
  label     text,                   -- сырой текст заголовка
  pct       int,                    -- % положительных рецензий
  count     int,                    -- всего оценок/рецензий
  avg       numeric,                -- средняя оценка (звёзды), если показана
  positive  int,
  negative  int,
  PRIMARY KEY (film_id, scope)
);
CREATE INDEX IF NOT EXISTS idx_critics_film ON film_critics(film_id);

-- самообнаружение новых атрибутов: любой впервые встреченный ключ страницы.
-- source: 'table' (data-test-id строки) | 'ld' (ключ ld+json). Один ряд на ключ.
CREATE TABLE IF NOT EXISTS discovered_attrs (
  source        text NOT NULL,
  key           text NOT NULL,
  first_film_id bigint,
  first_value   text,
  status        text NOT NULL DEFAULT 'new',  -- new | promoted | deferred | ignored
  first_seen    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, key)
);

-- архив исходного HTML (решение 27): перед парсингом ЛЮБОЙ страницы (главная фильма,
-- его подстраницы, страница персоны) её исходник целиком кладётся сюда. Страховка, чтобы
-- переразбирать офлайн и не возвращаться на сайт. Postgres хранит большие строки через TOAST
-- со сжатием — отдельный gzip не нужен. url = origin+path (без query).
CREATE TABLE IF NOT EXISTS page_html (
  url        text PRIMARY KEY,
  raw_html   text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- очередь обнаруженных ссылок (с любых страниц Сайта): фильмы и персоны.
-- title — текст ссылки (название), если удалось снять. status вычисляем на чтении
-- (фильм «новый», если его ещё нет в films).
CREATE TABLE IF NOT EXISTS link_queue (
  kind       text   NOT NULL,            -- 'film' | 'person'
  id         bigint NOT NULL,
  title      text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_queue_seen ON link_queue(first_seen);

CREATE INDEX IF NOT EXISTS idx_credits_person ON film_credits(person_id);
CREATE INDEX IF NOT EXISTS idx_films_genres   ON films USING gin(genres);
CREATE INDEX IF NOT EXISTS idx_films_countries ON films USING gin(countries);
CREATE INDEX IF NOT EXISTS idx_persons_enriched ON persons(enriched) WHERE enriched = false;
