/* Очередь/обнаружение: какие фильмы уже в БД, складирование ссылок, выборка для панели. */
const { pool } = require("./db");

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
  // нерешённые обнаруженные атрибуты (status='new') — показываем в панели ПОСТОЯННО, пока не затриажены
  const pa = await pool.query(
    `SELECT source, key, first_film_id, first_value FROM discovered_attrs
      WHERE status = 'new' ORDER BY first_seen`
  );
  return {
    films: nw.rows.map((x) => ({ id: Number(x.id), title: x.title })),
    recrawl: rc.rows.map((x) => ({ id: Number(x.id), title: x.title })),
    pendingAttrs: pa.rows.map((x) => ({
      source: x.source, key: x.key,
      firstFilmId: x.first_film_id != null ? Number(x.first_film_id) : null,
      firstValue: x.first_value,
    })),
  };
}

module.exports = { knownFilmIds, discoverLinks, queueFilms };
