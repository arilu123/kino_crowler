/* Очередь/обнаружение: какие фильмы уже в БД, складирование ссылок, выборка для панели. */
const { pool } = require("./db");

// строки очереди для подстраниц сериала (детерминированные URL по id). Единый источник правды
// для discoverLinks (обнаружение ссылок) и saveSeries (разбор главной сериала).
function seriesSubpageRows(id) {
  return [
    ["page:series:cast", id, `/series/${id}/cast/`],
    ["page:series:episodes", id, `/series/${id}/episodes/`],
  ];
}

// какие из переданных id фильмов уже есть в БД (для подсветки посещённых)
async function knownFilmIds(ids) {
  const clean = (ids || []).map(Number).filter(Boolean);
  if (!clean.length) return [];
  const r = await pool.query("SELECT id FROM films WHERE id = ANY($1)", [clean]);
  return r.rows.map((x) => Number(x.id));
}

// положить обнаруженные ссылки в очередь (с любых страниц Сайта)
// films/persons: [{id,title}]; pages: [{filmId, section, url}] — подстраницы фильма (ветки);
// sections: [{section, filmId, url}] — самообнаружение НОВЫХ типов разделов (не в очередь, а в триаж).
async function discoverLinks({ films, persons, series, companies, pages, sections }) {
  const rows = [];
  for (const x of films || []) if (x && x.id) rows.push(["film", Number(x.id), x.title || null]);
  for (const x of persons || []) if (x && x.id) rows.push(["person", Number(x.id), x.title || null]);
  // сериалы: отдельный kind='series' (id-пространство пересекается с films, поэтому НЕ 'film').
  // Заодно ДЕТЕРМИНИРОВАННО ставим в очередь известные подстраницы сериала: на странице сериала
  // ссылки на них ведут в /film/-неймспейс, поэтому НЕ ищем сканером, а выводим из id —
  //   page:series:cast → /series/{id}/cast/ (полный каст → series_credits),
  //   page:series:episodes → /series/{id}/episodes/ (сезоны/эпизоды → series_episodes).
  // Всё в ту же link_queue; разные kind не конфликтуют с одноимёнными id фильмов.
  for (const x of series || []) {
    if (!x || !x.id) continue;
    const id = Number(x.id);
    rows.push(["series", id, x.title || null]);
    rows.push(...seriesSubpageRows(id));
  }
  // кинокомпании (хаб обнаружения): kind='company:<ns>' (ns=company|studio — разные пространства id).
  // Данные не пишем — фильмы/сериалы компании ловит общий сканер; это реестр компаний для обхода.
  for (const x of companies || [])
    if (x && x.id && x.ns) rows.push(["company:" + x.ns, Number(x.id), x.name || null]);
  for (const x of pages || [])
    if (x && x.filmId && x.section) rows.push(["page:" + x.section, Number(x.filmId), x.url || null]);
  // новые типы разделов → discovered_attrs source='section'. Известные засеяны (promoted/ignored),
  // поэтому ON CONFLICT DO NOTHING оставит как status='new' только реально новый раздел → плашка в панели.
  const secRows = (sections || []).filter((s) => s && s.section);
  if (!rows.length && !secRows.length) return { added: 0, sections: 0 };
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
    for (const s of secRows) {
      await client.query(
        `INSERT INTO discovered_attrs (source, key, first_film_id, first_value)
         VALUES ('section', $1, $2, $3) ON CONFLICT (source, key) DO NOTHING`,
        [String(s.section).toLowerCase(), s.filmId != null ? Number(s.filmId) : null, (s.url || "").slice(0, 500)]
      );
    }
  } finally {
    client.release();
  }
  return { added: rows.length, sections: secRows.length };
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
  // реальные итоги обеих групп (не обрезанные лимитом) — для счётчика в панели
  const nwTotal = await pool.query(
    `SELECT count(*)::int AS n FROM link_queue q
      WHERE q.kind = 'film'
        AND NOT EXISTS (SELECT 1 FROM films f WHERE f.id = q.id)`
  );
  const rcTotal = await pool.query(
    `SELECT count(*)::int AS n FROM films
      WHERE raw IS NOT NULL AND critics_checked = false`
  );
  // нерешённые обнаруженные атрибуты (status='new') — показываем в панели ПОСТОЯННО, пока не затриажены
  const pa = await pool.query(
    `SELECT source, key, first_film_id, first_value FROM discovered_attrs
      WHERE status = 'new' ORDER BY first_seen`
  );
  return {
    films: nw.rows.map((x) => ({ id: Number(x.id), title: x.title })),
    filmsTotal: nwTotal.rows[0].n,
    recrawl: rc.rows.map((x) => ({ id: Number(x.id), title: x.title })),
    recrawlTotal: rcTotal.rows[0].n,
    pendingAttrs: pa.rows.map((x) => ({
      source: x.source, key: x.key,
      firstFilmId: x.first_film_id != null ? Number(x.first_film_id) : null,
      firstValue: x.first_value,
    })),
  };
}

module.exports = { knownFilmIds, discoverLinks, queueFilms, seriesSubpageRows };
