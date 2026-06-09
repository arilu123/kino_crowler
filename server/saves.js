/* Запись данных в БД: фильм (главная), каст, даты, сборы, студии, связи, ключевые слова,
 * награды, персона, исходный HTML. Самообнаружение новых атрибутов → discovered_attrs. */
const { pool } = require("./db");
const { seriesSubpageRows } = require("./queue");

// порядок ролей в film_credits
const CREW_ROLES = [
  "directors", "writers", "producers", "operators",
  "composers", "designers", "editors",
];

// известные ключи — всё, что вне их, попадёт в discovered_attrs как новый атрибут
const KNOWN_TABLE_KEYS = new Set([
  "encyclopedic-table", "next-link",
  "year", "countries", "genres", "tagline", "directors", "writers", "producers",
  "operators", "composers", "designers", "filmEditors", "budget", "usaBox",
  "worldBox", "rusBox", "audience", "ruPremiere", "worldPremieres", "dvdRelease",
  "ageRestriction", "ratingMPAA", "duration",
  "blueRayRelease", "digitalRelease", "reRelease",  // решение 9: вынесены в колонки
  "marketing",                                      // решение 14: расходы на маркетинг
  "originals",                                      // первоисточник (на чём основан фильм)
]);
const KNOWN_LD_KEYS = new Set([
  "@context", "@type", "url", "name", "alternativeHeadline", "alternateName",
  "description", "aggregateRating", "image", "genre", "contentRating",
  "isFamilyFriendly", "producer", "director", "actor", "countryOfOrigin",
  "timeRequired", "datePublished",
  "award", "video",  // решение 9: пока живут в raw (_ld), структура позже
  "numberOfEpisodes",                               // сериалы: число эпизодов → series.episodes_total
]);
// известные строки страницы персоны (/name/{id}/); прочее → discovered_attrs source='name'
const KNOWN_NAME_KEYS = new Set([
  "career", "height", "birthday", "deathday", "placeOfBirthday",
  "mainGenres", "filmographyTotal",
]);

// возвращает список ВПЕРВЫЕ встреченных (вставленных) ключей вида 'table:key' / 'ld:key'
async function recordDiscoveries(client, movie) {
  const fresh = [];
  const tbl = movie._allTable || {};
  for (const [key, value] of Object.entries(tbl)) {
    if (KNOWN_TABLE_KEYS.has(key)) continue;
    const r = await client.query(
      `INSERT INTO discovered_attrs (source, key, first_film_id, first_value)
       VALUES ('table', $1, $2, $3) ON CONFLICT (source, key) DO NOTHING`,
      [key, movie.id, (value || "").slice(0, 500)]
    );
    if (r.rowCount === 1) fresh.push("table:" + key);
  }
  for (const key of Object.keys(movie._ld || {})) {
    if (KNOWN_LD_KEYS.has(key)) continue;
    const r = await client.query(
      `INSERT INTO discovered_attrs (source, key, first_film_id, first_value)
       VALUES ('ld', $1, $2, NULL) ON CONFLICT (source, key) DO NOTHING`,
      [key, movie.id]
    );
    if (r.rowCount === 1) fresh.push("ld:" + key);
  }
  return fresh;
}

function collectCredits(movie) {
  const out = []; // {id, name, role, ord}
  const crew = movie.crew || {};
  for (const role of CREW_ROLES) {
    (crew[role] || []).forEach((p, i) => {
      if (p && p.id) out.push({ id: p.id, name: p.name || null, role, ord: i });
    });
  }
  (movie.actors || []).forEach((p, i) => {
    if (p && p.id) out.push({ id: p.id, name: p.name || null, role: "actor", ord: i });
  });
  return out;
}

async function saveMovie(movie) {
  if (!movie || !movie.id) throw new Error("no movie id");
  const r = movie.rating || {};
  const bo = movie.boxOffice || {};
  const pr = movie.premieres || {};
  const rel = movie.releases || {};
  const poster =
    typeof movie.poster === "string" && !/^data:/i.test(movie.poster) ? movie.poster : null;
  const credits = collectCredits(movie);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const filmRes = await client.query(
      `INSERT INTO films (
         id, title, title_orig, year, slogan, genres, countries, duration,
         age_restriction, rating_mpaa, rating_value, rating_count, description,
         box_budget, box_marketing, box_usa, box_world, box_rus, audience,
         premiere_ru, premiere_world, premiere_dvd,
         release_bluray, release_digital, re_release,
         source_url, raw, poster, originals, imdb_value, imdb_count,
         critics_checked, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31, true, now()
       )
       ON CONFLICT (id) DO UPDATE SET
         title=$2, title_orig=$3, year=$4, slogan=$5, genres=$6, countries=$7,
         duration=$8, age_restriction=$9, rating_mpaa=$10, rating_value=$11,
         rating_count=$12, description=$13, box_budget=$14, box_marketing=$15,
         box_usa=$16, box_world=$17, box_rus=$18, audience=$19, premiere_ru=$20,
         premiere_world=$21, premiere_dvd=$22,
         release_bluray=$23, release_digital=$24, re_release=$25,
         source_url=$26, raw=$27, poster=$28, originals=$29,
         imdb_value=$30, imdb_count=$31, critics_checked=true,
         updated_at=now()
       RETURNING crawled_at, updated_at, full_cast_fetched`,
      [
        movie.id, movie.title, movie.titleOrig, movie.year, movie.slogan,
        movie.genres || null, movie.countries || null, movie.duration,
        movie.ageRestriction, movie.ratingMPAA, r.value ?? null, r.count ?? null,
        movie.description, bo.budget ?? null, bo.marketing ?? null, bo.usa ?? null,
        bo.world ?? null, bo.rus ?? null, movie.audience, pr.ru ?? null,
        pr.world ?? null, pr.dvd ?? null,
        rel.bluray ?? null, rel.digital ?? null, rel.re ?? null,
        (movie.source && movie.source.url) || null, JSON.stringify(movie), poster,
        movie.originals ?? null,
        (movie.imdb && movie.imdb.value) ?? null, (movie.imdb && movie.imdb.count) ?? null,
      ]
    );

    // персоны: upsert без сброса enriched
    for (const p of credits) {
      await client.query(
        `INSERT INTO persons (id, name, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE
           SET name = COALESCE(persons.name, EXCLUDED.name), updated_at = now()`,
        [p.id, p.name]
      );
    }

    // состав с главной — НЕ перезатираем полный каст, если он уже собран со /cast/
    if (!filmRes.rows[0].full_cast_fetched) {
      await client.query("DELETE FROM film_credits WHERE film_id=$1", [movie.id]);
      for (const p of credits) {
        await client.query(
          `INSERT INTO film_credits (film_id, person_id, role, ord)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [movie.id, p.id, p.role, p.ord]
        );
      }
    }

    // рейтинг кинокритиков (мир/РФ) — пересобираем
    await client.query("DELETE FROM film_critics WHERE film_id=$1", [movie.id]);
    for (const c of movie.critics || []) {
      if (!c || !c.scope) continue;
      await client.query(
        `INSERT INTO film_critics (film_id, scope, label, pct, count, avg, positive, negative)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (film_id, scope) DO UPDATE SET
           label=EXCLUDED.label, pct=EXCLUDED.pct, count=EXCLUDED.count, avg=EXCLUDED.avg,
           positive=EXCLUDED.positive, negative=EXCLUDED.negative`,
        [movie.id, c.scope, c.label || null, c.pct ?? null, c.count ?? null,
         c.avg ?? null, c.positive ?? null, c.negative ?? null]
      );
    }

    const newAttrs = await recordDiscoveries(client, movie);

    // в очереди этот фильм теперь точно с известным названием
    await client.query(
      `INSERT INTO link_queue (kind, id, title) VALUES ('film', $1, $2)
       ON CONFLICT (kind, id) DO UPDATE SET title = COALESCE(EXCLUDED.title, link_queue.title)`,
      [movie.id, movie.title || null]
    );

    await client.query("COMMIT");
    const { crawled_at, updated_at } = filmRes.rows[0];
    const isNew = crawled_at.getTime() === updated_at.getTime();
    return {
      id: movie.id,
      title: movie.title,
      persons: credits.length,
      isNew,
      firstSeen: crawled_at,
      newAttrs,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// главная страница сериала /series/{id}/ → отдельные таблицы series / series_credits.
// Объект — тот же, что отдаёт extract() фильма (страница идентична по формату), пишем в series.*.
// Критики/IMDb-разбивка пока только в raw (как было у фильмов на старте) — колонки позже при нужде.
async function saveSeries(movie) {
  if (!movie || !movie.id) throw new Error("no series id");
  const r = movie.rating || {};
  const bo = movie.boxOffice || {};
  const pr = movie.premieres || {};
  const rel = movie.releases || {};
  const poster =
    typeof movie.poster === "string" && !/^data:/i.test(movie.poster) ? movie.poster : null;
  const credits = collectCredits(movie);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query(
      `INSERT INTO series (
         id, title, title_orig, year, slogan, genres, countries, duration,
         age_restriction, rating_mpaa, rating_value, rating_count, description,
         box_budget, box_marketing, box_usa, box_world, box_rus, audience,
         premiere_ru, premiere_world, premiere_dvd,
         release_bluray, release_digital, re_release,
         source_url, raw, poster, originals, imdb_value, imdb_count, episodes_total, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32, now()
       )
       ON CONFLICT (id) DO UPDATE SET
         title=$2, title_orig=$3, year=$4, slogan=$5, genres=$6, countries=$7,
         duration=$8, age_restriction=$9, rating_mpaa=$10, rating_value=$11,
         rating_count=$12, description=$13, box_budget=$14, box_marketing=$15,
         box_usa=$16, box_world=$17, box_rus=$18, audience=$19, premiere_ru=$20,
         premiere_world=$21, premiere_dvd=$22,
         release_bluray=$23, release_digital=$24, re_release=$25,
         source_url=$26, raw=$27, poster=$28, originals=$29,
         imdb_value=$30, imdb_count=$31, episodes_total=$32, updated_at=now()
       RETURNING crawled_at, updated_at, full_cast_fetched`,
      [
        movie.id, movie.title, movie.titleOrig, movie.year, movie.slogan,
        movie.genres || null, movie.countries || null, movie.duration,
        movie.ageRestriction, movie.ratingMPAA, r.value ?? null, r.count ?? null,
        movie.description, bo.budget ?? null, bo.marketing ?? null, bo.usa ?? null,
        bo.world ?? null, bo.rus ?? null, movie.audience, pr.ru ?? null,
        pr.world ?? null, pr.dvd ?? null,
        rel.bluray ?? null, rel.digital ?? null, rel.re ?? null,
        (movie.source && movie.source.url) || null, JSON.stringify(movie), poster,
        movie.originals ?? null,
        (movie.imdb && movie.imdb.value) ?? null, (movie.imdb && movie.imdb.count) ?? null,
        movie.episodesTotal ?? null,
      ]
    );

    for (const p of credits) {
      await client.query(
        `INSERT INTO persons (id, name, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE
           SET name = COALESCE(persons.name, EXCLUDED.name), updated_at = now()`,
        [p.id, p.name]
      );
    }

    // состав с главной — не перезатираем, если полный каст уже собран со /series/{id}/cast/
    if (!res.rows[0].full_cast_fetched) {
      await client.query("DELETE FROM series_credits WHERE series_id=$1", [movie.id]);
      for (const p of credits) {
        await client.query(
          `INSERT INTO series_credits (series_id, person_id, role, ord)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [movie.id, p.id, p.role, p.ord]
        );
      }
    }

    const newAttrs = await recordDiscoveries(client, movie);

    await client.query(
      `INSERT INTO link_queue (kind, id, title) VALUES ('series', $1, $2)
       ON CONFLICT (kind, id) DO UPDATE SET title = COALESCE(EXCLUDED.title, link_queue.title)`,
      [movie.id, movie.title || null]
    );
    // подстраницы сериала в очередь (детерминированные URL) — гарантированно при разборе главной
    for (const [kind, id, title] of seriesSubpageRows(movie.id)) {
      await client.query(
        `INSERT INTO link_queue (kind, id, title) VALUES ($1, $2, $3)
         ON CONFLICT (kind, id) DO UPDATE SET title = COALESCE(link_queue.title, EXCLUDED.title)`,
        [kind, id, title]
      );
    }

    await client.query("COMMIT");
    const { crawled_at, updated_at } = res.rows[0];
    const isNew = crawled_at.getTime() === updated_at.getTime();
    return {
      id: movie.id, title: movie.title, persons: credits.length,
      isNew, firstSeen: crawled_at, newAttrs,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// полный каст со страницы /film/{id}/cast/ — авторитетно пересобирает film_credits
async function saveCast({ filmId, credits }) {
  filmId = Number(filmId);
  if (!filmId || !Array.isArray(credits) || !credits.length) throw new Error("bad cast");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO films (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
      [filmId]
    );
    for (const c of credits) {
      if (!c.id) continue;
      await client.query(
        `INSERT INTO persons (id, name, name_orig, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(persons.name, EXCLUDED.name),
           name_orig = COALESCE(persons.name_orig, EXCLUDED.name_orig),
           updated_at = now()`,
        [c.id, c.name || null, c.nameOrig || null]
      );
    }
    await client.query("DELETE FROM film_credits WHERE film_id=$1", [filmId]);
    for (const c of credits) {
      if (!c.id) continue;
      await client.query(
        `INSERT INTO film_credits (film_id, person_id, role, ord, character)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [filmId, c.id, c.role, c.ord ?? null, c.character || null]
      );
    }
    await client.query(
      "UPDATE films SET full_cast_fetched=true, updated_at=now() WHERE id=$1",
      [filmId]
    );
    await client.query("COMMIT");
    return { filmId, credits: credits.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// полный каст сериала со страницы /series/{id}/cast/ — авторитетно пересобирает series_credits.
// Страница каста идентична фильмовой, поэтому формат credits тот же, что у saveCast.
async function saveSeriesCast({ seriesId, credits }) {
  seriesId = Number(seriesId);
  if (!seriesId || !Array.isArray(credits) || !credits.length) throw new Error("bad series cast");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO series (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [seriesId]);
    for (const c of credits) {
      if (!c.id) continue;
      await client.query(
        `INSERT INTO persons (id, name, name_orig, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(persons.name, EXCLUDED.name),
           name_orig = COALESCE(persons.name_orig, EXCLUDED.name_orig),
           updated_at = now()`,
        [c.id, c.name || null, c.nameOrig || null]
      );
    }
    await client.query("DELETE FROM series_credits WHERE series_id=$1", [seriesId]);
    for (const c of credits) {
      if (!c.id) continue;
      await client.query(
        `INSERT INTO series_credits (series_id, person_id, role, ord, character)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [seriesId, c.id, c.role, c.ord ?? null, c.character || null]
      );
    }
    await client.query("UPDATE series SET full_cast_fetched=true, updated_at=now() WHERE id=$1", [seriesId]);
    await client.query("COMMIT");
    return { seriesId, credits: credits.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// эпизоды со страницы /series/{id}/episodes/ — пересобирает series_episodes
async function saveEpisodes({ seriesId, episodes }) {
  seriesId = Number(seriesId);
  if (!seriesId || !Array.isArray(episodes) || !episodes.length) throw new Error("bad episodes");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO series (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [seriesId]);
    await client.query("DELETE FROM series_episodes WHERE series_id=$1", [seriesId]);
    for (const e of episodes) {
      await client.query(
        `INSERT INTO series_episodes (series_id, season, episode, ord, title, title_orig, air_date, air_date_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [seriesId, e.season, e.episode, e.ord, e.title || null, e.titleOrig || null,
         e.airDate || null, e.airDateText || null]
      );
    }
    await client.query("UPDATE series SET episodes_fetched=true, updated_at=now() WHERE id=$1", [seriesId]);
    await client.query("COMMIT");
    return { seriesId, episodes: episodes.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// даты со страницы /film/{id}/dates/ — пересобирает film_dates
async function saveDates({ filmId, dates }) {
  filmId = Number(filmId);
  if (!filmId || !Array.isArray(dates) || !dates.length) throw new Error("bad dates");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO films (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [filmId]);
    await client.query("DELETE FROM film_dates WHERE film_id=$1", [filmId]);
    for (const d of dates) {
      await client.query(
        `INSERT INTO film_dates (film_id, ord, date_text, date, country_id, country, type, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [filmId, d.ord, d.dateText || null, d.date || null, d.countryId ?? null,
         d.country || null, d.type || null, d.note || null]
      );
    }
    await client.query("UPDATE films SET dates_fetched=true, updated_at=now() WHERE id=$1", [filmId]);
    await client.query("COMMIT");
    return { filmId, dates: dates.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// сборы со страницы /film/{id}/box/ (+ вкладки стран) — пересобирает film_box по (film,tab)
async function saveBox({ filmId, tab, rows }) {
  filmId = Number(filmId);
  if (!filmId || !Array.isArray(rows) || !rows.length) throw new Error("bad box");
  tab = tab || "США";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO films (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [filmId]);
    await client.query("DELETE FROM film_box WHERE film_id=$1 AND tab=$2", [filmId, tab]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO film_box (film_id, tab, ord, section, label, value, amount, currency, pct, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [filmId, tab, r.ord, r.section || null, r.label || null, r.value || null,
         r.amount ?? null, r.currency || null, r.pct ?? null, r.note || null]
      );
    }
    await client.query("UPDATE films SET box_fetched=true, updated_at=now() WHERE id=$1", [filmId]);
    await client.query("COMMIT");
    return { filmId, tab, rows: rows.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// студии + тех.данные со страницы /film/{id}/studio/ — пересобирает film_studios и film_tech
async function saveStudio({ filmId, tech, studios }) {
  filmId = Number(filmId);
  tech = Array.isArray(tech) ? tech : [];
  studios = Array.isArray(studios) ? studios : [];
  if (!filmId || (!tech.length && !studios.length)) throw new Error("bad studio");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO films (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [filmId]);

    await client.query("DELETE FROM film_studios WHERE film_id=$1", [filmId]);
    for (const s of studios) {
      await client.query(
        `INSERT INTO film_studios (film_id, role, ord, company_kind, company_id, company_ref, name, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [filmId, s.role, s.ord, s.companyKind || null, s.companyId ?? null,
         s.companyRef || null, s.name || null, s.note || null]
      );
    }

    await client.query("DELETE FROM film_tech WHERE film_id=$1", [filmId]);
    for (const t of tech) {
      await client.query(
        `INSERT INTO film_tech (film_id, ord, label, value) VALUES ($1,$2,$3,$4)`,
        [filmId, t.ord, t.label || null, t.value || null]
      );
    }

    await client.query("UPDATE films SET studio_fetched=true, updated_at=now() WHERE id=$1", [filmId]);
    await client.query("COMMIT");
    return { filmId, studios: studios.length, tech: tech.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// связанные фильмы со страницы /film/{id}/other/ — пересобирает film_relations
async function saveOther({ filmId, relations }) {
  filmId = Number(filmId);
  if (!filmId || !Array.isArray(relations) || !relations.length) throw new Error("bad other");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO films (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [filmId]);
    await client.query("DELETE FROM film_relations WHERE film_id=$1", [filmId]);
    for (const r of relations) {
      await client.query(
        `INSERT INTO film_relations (film_id, relation, ord, related_id, title, title_orig, year)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [filmId, r.relation, r.ord, r.relatedId ?? null, r.title || null, r.titleOrig || null, r.year ?? null]
      );
    }
    await client.query("UPDATE films SET other_fetched=true, updated_at=now() WHERE id=$1", [filmId]);
    await client.query("COMMIT");
    return { filmId, relations: relations.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// похожие фильмы со страницы /film/{id}/like/ — пересобирает film_similar
async function saveLike({ filmId, similar }) {
  filmId = Number(filmId);
  if (!filmId || !Array.isArray(similar) || !similar.length) throw new Error("bad like");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO films (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [filmId]);
    await client.query("DELETE FROM film_similar WHERE film_id=$1", [filmId]);
    for (const s of similar) {
      await client.query(
        `INSERT INTO film_similar (film_id, ord, similar_id, title, title_orig, year)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [filmId, s.ord, s.similarId ?? null, s.title || null, s.titleOrig || null, s.year ?? null]
      );
    }
    await client.query("UPDATE films SET like_fetched=true, updated_at=now() WHERE id=$1", [filmId]);
    await client.query("COMMIT");
    return { filmId, similar: similar.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ключевые слова со страницы /film/{id}/keywords/ — пересобирает film_keywords
async function saveKeywords({ filmId, keywords }) {
  filmId = Number(filmId);
  if (!filmId || !Array.isArray(keywords) || !keywords.length) throw new Error("bad keywords");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO films (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [filmId]);
    await client.query("DELETE FROM film_keywords WHERE film_id=$1", [filmId]);
    for (const k of keywords) {
      await client.query(
        `INSERT INTO film_keywords (film_id, ord, keyword_id, keyword) VALUES ($1,$2,$3,$4)`,
        [filmId, k.ord, k.keywordId ?? null, k.keyword || null]
      );
    }
    await client.query("UPDATE films SET keywords_fetched=true, updated_at=now() WHERE id=$1", [filmId]);
    await client.query("COMMIT");
    return { filmId, keywords: keywords.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// награды/номинации со страницы /film/{id}/awards/ — пересобирает film_awards.
// Попутно upsert'им заглушки персон (как в касте), чтобы привязанные к наградам люди
// попали в очередь обогащения.
async function saveAwards({ filmId, awards }) {
  filmId = Number(filmId);
  if (!filmId || !Array.isArray(awards) || !awards.length) throw new Error("bad awards");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO films (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [filmId]);
    for (const a of awards) {
      if (!a.personId) continue;
      await client.query(
        `INSERT INTO persons (id, name, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(persons.name, EXCLUDED.name),
           updated_at = now()`,
        [a.personId, a.personName || null]
      );
    }
    await client.query("DELETE FROM film_awards WHERE film_id=$1", [filmId]);
    for (const a of awards) {
      await client.query(
        `INSERT INTO film_awards
           (film_id, ord, award_slug, award_name, year, country, result, category, nom_id, person_id, person_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [filmId, a.ord, a.awardSlug || null, a.awardName || null, a.year ?? null,
         a.country || null, a.result || null, a.category || null, a.nomId || null,
         a.personId ?? null, a.personName || null]
      );
    }
    await client.query("UPDATE films SET awards_fetched=true, updated_at=now() WHERE id=$1", [filmId]);
    await client.query("COMMIT");
    return { filmId, awards: awards.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// персона со страницы /name/{id}/ — обогащение persons (решение 26).
// Самообнаружение новых строк (data-test-id) → discovered_attrs source='name'.
async function recordPersonDiscoveries(client, person) {
  const fresh = [];
  const rows = person._rows || {};
  for (const [key, value] of Object.entries(rows)) {
    if (KNOWN_NAME_KEYS.has(key)) continue;
    const r = await client.query(
      `INSERT INTO discovered_attrs (source, key, first_film_id, first_value)
       VALUES ('name', $1, $2, $3) ON CONFLICT (source, key) DO NOTHING`,
      [key, person.id, (value || "").slice(0, 500)]
    );
    if (r.rowCount === 1) fresh.push("name:" + key);
  }
  return fresh;
}

async function savePerson({ person }) {
  if (!person || !person.id) throw new Error("no person id");
  const id = Number(person.id);
  const photo =
    typeof person.photo === "string" && !/^data:/i.test(person.photo) ? person.photo : null;
  const arr = (a) => (Array.isArray(a) && a.length ? a : null);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const newAttrs = await recordPersonDiscoveries(client, person);
    // COALESCE имени: не затираем уже известное, если со страницы пришло пустое
    await client.query(
      `INSERT INTO persons (
         id, name, name_orig, gender, birth_date, death_date, birth_place,
         height_cm, zodiac, professions, genres, films_total, career_start,
         career_end, photo, source_url, enriched, raw, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, true, $17, now()
       )
       ON CONFLICT (id) DO UPDATE SET
         name        = COALESCE(EXCLUDED.name, persons.name),
         name_orig   = COALESCE(EXCLUDED.name_orig, persons.name_orig),
         gender      = COALESCE(EXCLUDED.gender, persons.gender),
         birth_date  = COALESCE(EXCLUDED.birth_date, persons.birth_date),
         death_date  = COALESCE(EXCLUDED.death_date, persons.death_date),
         birth_place = COALESCE(EXCLUDED.birth_place, persons.birth_place),
         height_cm   = COALESCE(EXCLUDED.height_cm, persons.height_cm),
         zodiac      = COALESCE(EXCLUDED.zodiac, persons.zodiac),
         professions = COALESCE(EXCLUDED.professions, persons.professions),
         genres      = COALESCE(EXCLUDED.genres, persons.genres),
         films_total = COALESCE(EXCLUDED.films_total, persons.films_total),
         career_start= COALESCE(EXCLUDED.career_start, persons.career_start),
         career_end  = COALESCE(EXCLUDED.career_end, persons.career_end),
         photo       = COALESCE(EXCLUDED.photo, persons.photo),
         source_url  = EXCLUDED.source_url,
         enriched    = true,
         raw         = EXCLUDED.raw,
         updated_at  = now()`,
      [
        id, person.name || null, person.nameOrig || null, person.gender || null,
        person.birthDate || null, person.deathDate || null, person.birthPlace || null,
        person.heightCm ?? null, person.zodiac || null, arr(person.professions),
        arr(person.genres), person.filmsTotal ?? null, person.careerStart ?? null,
        person.careerEnd ?? null, photo, person.sourceUrl || null,
        JSON.stringify({ _ld: person._ld ?? null, _rows: person._rows ?? null }),
      ]
    );

    // фильмография по профессиям — пересобираем (DELETE+INSERT), только если пришла
    const filmography = Array.isArray(person.filmography) ? person.filmography : [];
    if (filmography.length) {
      await client.query("DELETE FROM person_filmography WHERE person_id=$1", [id]);
      for (const f of filmography) {
        await client.query(
          `INSERT INTO person_filmography (person_id, ord, role, subrole, films_count, label)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, f.ord, f.role || null, f.subrole || null, f.count ?? null, f.label || null]
        );
      }
    }

    await client.query("COMMIT");
    return { id, name: person.name || null, enriched: true, newAttrs, filmography: filmography.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// исходный HTML страницы (решение 27): upsert по url. Сохраняем ПЕРЕД парсингом.
async function saveHtml({ url, html }) {
  if (!url || typeof html !== "string" || !html.length) throw new Error("bad html");
  await pool.query(
    `INSERT INTO page_html (url, raw_html, fetched_at) VALUES ($1,$2,now())
     ON CONFLICT (url) DO UPDATE SET raw_html=EXCLUDED.raw_html, fetched_at=now()`,
    [url, html]
  );
  return { url, bytes: html.length };
}

module.exports = {
  saveMovie, saveCast, saveDates, saveBox, saveStudio,
  saveOther, saveLike, saveKeywords, saveAwards, savePerson, saveHtml,
  saveSeries, saveSeriesCast, saveEpisodes,
};
