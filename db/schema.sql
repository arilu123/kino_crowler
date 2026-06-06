-- Kinopoisk crawler — схема БД (Postgres). Прагматичная нормализация.
-- Применить:  psql -h localhost -U mac -d kinopoisk -f db/schema.sql

CREATE TABLE IF NOT EXISTS films (
  id                bigint PRIMARY KEY,            -- id фильма на Кинопоиске
  title             text,
  title_orig        text,
  year              int,
  slogan            text,
  genres            text[],
  countries         text[],
  duration          int,                           -- минуты
  age_restriction   text,
  rating_mpaa       text,
  rating_value      numeric,
  rating_count      int,
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
  crawled_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS persons (
  id          bigint PRIMARY KEY,                  -- id персоны на Кинопоиске (/name/{id}/)
  name        text,
  name_orig   text,                                -- оригинальное имя (со страницы каста)
  enriched    boolean NOT NULL DEFAULT false,      -- страница персоны ещё не разобрана (это и есть очередь)
  raw         jsonb,
  crawled_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

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
