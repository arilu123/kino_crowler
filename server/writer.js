/*
 * Локальный писатель краулера → Postgres. Node >=18.
 * Запуск:  node server/writer.js        (из корня проекта)
 * Зависимости: pg (npm i, уже в server/package.json).
 *
 * Принимает POST /movie с JSON фильма (схема — extractor.js / movie-info-list.md).
 * Делает в одной транзакции:
 *   - upsert в films (ON CONFLICT id → обновление, updated_at=now()).
 *   - upsert каждой персоны в persons (НЕ трогает флаг enriched).
 *   - пересборку film_credits (DELETE по film_id → INSERT актуального состава).
 *
 * БД — единственный источник правды. Очередь «что добрать»:
 *   persons WHERE enriched=false   /   films WHERE full_cast_fetched=false.
 */
const http = require("http");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8787;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://mac@localhost:5432/kinopoisk",
});

// живучесть: не падать молча на разовых ошибках
pool.on("error", (e) => console.error("pg pool error:", e.message));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

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

// какие из переданных id фильмов уже есть в БД (для подсветки посещённых)
async function knownFilmIds(ids) {
  const clean = (ids || []).map(Number).filter(Boolean);
  if (!clean.length) return [];
  const r = await pool.query("SELECT id FROM films WHERE id = ANY($1)", [clean]);
  return r.rows.map((x) => Number(x.id));
}

// положить обнаруженные ссылки в очередь (с любых страниц Сайта)
// films/persons: [{id,title}]; pages: [{filmId, section, url}] — подстраницы фильма (ветки)
async function discoverLinks({ films, persons, pages }) {
  const rows = [];
  for (const x of films || []) if (x && x.id) rows.push(["film", Number(x.id), x.title || null]);
  for (const x of persons || []) if (x && x.id) rows.push(["person", Number(x.id), x.title || null]);
  for (const x of pages || [])
    if (x && x.filmId && x.section) rows.push(["page:" + x.section, Number(x.filmId), x.url || null]);
  if (!rows.length) return { added: 0 };
  const client = await pool.connect();
  try {
    for (const [kind, id, title] of rows) {
      await client.query(
        `INSERT INTO link_queue (kind, id, title) VALUES ($1, $2, $3)
         ON CONFLICT (kind, id) DO UPDATE
           SET title = COALESCE(link_queue.title, EXCLUDED.title)`,
        [kind, id, title]
      );
    }
  } finally {
    client.release();
  }
  return { added: rows.length };
}

// очередь для панели: две группы со своими лимитами —
//  films   — НОВЫЕ (в link_queue, ещё нет в films), FIFO;
//  recrawl — К ПЕРЕОБХОДУ (главная снята, но critics_checked=false: добор критиков/IMDb и пр.).
// По мере захода фильм уходит из своей группы сам (попал в films / выставлен critics_checked).
async function queueFilms(nLimit = 10, rLimit = 12) {
  const nw = await pool.query(
    `SELECT q.id, q.title FROM link_queue q
      WHERE q.kind = 'film'
        AND NOT EXISTS (SELECT 1 FROM films f WHERE f.id = q.id)
      ORDER BY q.first_seen LIMIT $1`,
    [nLimit]
  );
  const rc = await pool.query(
    `SELECT id, title FROM films
      WHERE raw IS NOT NULL AND critics_checked = false
      ORDER BY id LIMIT $1`,
    [rLimit]
  );
  return {
    films: nw.rows.map((x) => ({ id: Number(x.id), title: x.title })),
    recrawl: rc.rows.map((x) => ({ id: Number(x.id), title: x.title })),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.method === "POST" && req.url === "/movie") {
    try {
      const result = await saveMovie(JSON.parse(await readBody(req)));
      const tag = result.isNew ? "новый" : "обновлён";
      console.log(`✓ ${result.id} ${result.title} (${result.persons} персон, ${tag})`);
      if (result.newAttrs && result.newAttrs.length)
        console.log(`  🆕 новые атрибуты: ${result.newAttrs.join(", ")}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/cast") {
    try {
      const result = await saveCast(JSON.parse(await readBody(req)));
      console.log(`✓ каст ${result.filmId} (${result.credits} чел.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ cast", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/dates") {
    try {
      const result = await saveDates(JSON.parse(await readBody(req)));
      console.log(`✓ даты ${result.filmId} (${result.dates} зап.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ dates", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/box") {
    try {
      const result = await saveBox(JSON.parse(await readBody(req)));
      console.log(`✓ сборы ${result.filmId} (${result.tab}, ${result.rows} стр.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ box", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/studio") {
    try {
      const result = await saveStudio(JSON.parse(await readBody(req)));
      console.log(`✓ студии ${result.filmId} (${result.studios} комп., ${result.tech} тех.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ studio", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/other") {
    try {
      const result = await saveOther(JSON.parse(await readBody(req)));
      console.log(`✓ связи ${result.filmId} (${result.relations} фильмов)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ other", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/keywords") {
    try {
      const result = await saveKeywords(JSON.parse(await readBody(req)));
      console.log(`✓ ключ.слова ${result.filmId} (${result.keywords})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ keywords", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/known") {
    try {
      const { ids } = JSON.parse(await readBody(req));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ known: await knownFilmIds(ids) }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/discover") {
    try {
      const payload = JSON.parse(await readBody(req));
      const result = await discoverLinks(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/queue") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await queueFilms()));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () =>
  console.log(`kp-crawler writer → Postgres, слушает http://localhost:${PORT}`)
);
