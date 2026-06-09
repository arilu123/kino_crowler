/*
 * Краулер Кинопоиска — обнаружение ссылок.
 * Сбор ссылок (фильмы/персоны/подстраницы), подсветка посещённых, отправка в очередь.
 * Часть content-скрипта (загрузка по порядку из manifest.json, общий isolated-world scope).
 */
// ---------- сбор ссылок на странице (фильмы + персоны) ----------
// возвращает Map(id -> title|null), пропуская ссылки внутри нашей панели
function scan(selector, idOf) {
  const m = new Map();
  for (const a of document.querySelectorAll(selector)) {
    if (inPanel(a)) continue;
    const id = idOf(a.getAttribute("href"));
    if (!id) continue;
    const t = linkText(a);
    if (!m.has(id) || (!m.get(id) && t)) m.set(id, t || null);
  }
  return m;
}
const filmsOnPage = () => scan('a[href*="/film/"]', idFromFilm);
const personsOnPage = () => scan('a[href*="/name/"]', idFromName);
const seriesOnPage = () => scan('a[href*="/series/"]', idFromSeries);

// ---------- подсветка посещённых фильмов ----------
function applyMarks() {
  for (const a of document.querySelectorAll('a[href*="/film/"]')) {
    if (inPanel(a)) continue;
    const id = idFromFilm(a.getAttribute("href"));
    if (id && KNOWN_DB.has(id) && a.dataset.kpMarked !== "1") {
      a.dataset.kpMarked = "1";
      a.style.opacity = "0.2";
      a.title = (a.title ? a.title + " · " : "") + "kp: уже в БД";
    }
  }
}
function markLinks() {
  const fresh = [...filmsOnPage().keys()].filter((id) => !asked.has(id) && !KNOWN_DB.has(id));
  if (!fresh.length) return applyMarks();
  fresh.forEach((id) => asked.add(id));
  chrome.runtime.sendMessage({ type: "known", ids: fresh }, (resp) => {
    if (resp && resp.ok && resp.result) {
      (resp.result.known || []).forEach((id) => KNOWN_DB.add(Number(id)));
    }
    applyMarks();
  });
}

// подстраницы фильма (ветки): ссылка /film/{id}/<раздел>/... → {filmId, section, url}.
// БЕЛЫЙ СПИСОК нужных разделов: раньше захватывали всё подряд, но из ~1100 page:* в очереди
// ~773 оказались мусором (votes/posters/reviews/…; «rn» — вообще не раздел, а ссылка MPAA-рейтинга
// /film/{id}/rn/<R>/, у которой первый сегмент «rn» редиректит на главную). Состав нужных разделов
// стабилен — берём только их. box по странам идёт отдельно (boxCountryPages → page:box:<slug>).
const WANTED_SECTIONS = new Set([
  "cast", "dates", "box", "studio", "other", "like", "keywords", "awards",
]);
function pagesOnPage() {
  const m = new Map(); // "id:section" -> {filmId, section, url}
  for (const a of document.querySelectorAll('a[href*="/film/"]')) {
    if (inPanel(a)) continue;
    const mm = (a.getAttribute("href") || "").match(/\/film\/(\d+)\/([a-z][a-z0-9_]*)/i);
    if (!mm) continue; // это корень /film/ID/ (сам фильм) — не ветка
    const filmId = Number(mm[1]), section = mm[2].toLowerCase();
    if (!WANTED_SECTIONS.has(section)) continue;          // прочее (votes/rn/posters/…) не нужно
    const key = filmId + ":" + section;
    if (!m.has(key)) m.set(key, { filmId, section, url: `/film/${filmId}/${section}/` });
  }
  return m;
}

// box — страница ПО СТРАНАМ: каждая вкладка (`.insert li`) несёт детали только своей страны,
// в отличие от /cast/ (всё на одной). Активная вкладка (li.act) = текущая (уже парсим);
// у остальных есть <a href="/film/{id}/box/<country>/"> → их добавляем в очередь отдельно,
// чтобы дойти до каждой страны. section='box:<slug>' → kind='page:box:<slug>' (по строке на страну).
function boxCountryPages() {
  const out = [];
  const root = document.querySelector(".block_left") || document;
  for (const a of root.querySelectorAll('.insert li a[href*="/box/"]')) {
    if (inPanel(a)) continue;
    const mm = (a.getAttribute("href") || "").match(/\/film\/(\d+)\/box\/([a-z]+)\/?$/i);
    if (!mm) continue;
    out.push({ filmId: Number(mm[1]), section: "box:" + mm[2].toLowerCase(), url: mm[0] });
  }
  return out;
}

// ВСЕ типы разделов фильма, встреченные на странице (по одному примеру на тип). В ОЧЕРЕДЬ идут
// только нужные (pagesOnPage по белому списку), но о появлении НЕИЗВЕСТНОГО типа сообщаем writer'у →
// discovered_attrs source='section' → плашка в панели (как новые атрибуты). Известные типы заранее
// погашены (status promoted/ignored), поэтому всплывёт только реально новый раздел.
function allFilmSections() {
  const m = new Map(); // section -> {section, filmId, url}
  for (const a of document.querySelectorAll('a[href*="/film/"]')) {
    if (inPanel(a)) continue;
    const mm = (a.getAttribute("href") || "").match(/\/film\/(\d+)\/([a-z][a-z0-9_]*)/i);
    if (!mm) continue;
    const filmId = Number(mm[1]), section = mm[2].toLowerCase();
    if (!m.has(section)) m.set(section, { section, filmId, url: `/film/${filmId}/${section}/` });
  }
  return m;
}

// ---------- складирование обнаруженных ссылок в очередь ----------
const sentLinks = new Set(); // 'film:ID' / 'person:ID' / 'page:ID:section' / 'sect:section' — уже отправленные
function sendDiscover() {
  const films = [], persons = [], series = [], pages = [], sections = [];
  for (const [id, title] of filmsOnPage()) {
    const k = "film:" + id; if (sentLinks.has(k)) continue; sentLinks.add(k); films.push({ id, title });
  }
  for (const [id, title] of personsOnPage()) {
    const k = "person:" + id; if (sentLinks.has(k)) continue; sentLinks.add(k); persons.push({ id, title });
  }
  // сериалы: копим в очередь как kind='series' (контент пока не парсим, обход — отдельным проходом)
  for (const [id, title] of seriesOnPage()) {
    const k = "series:" + id; if (sentLinks.has(k)) continue; sentLinks.add(k); series.push({ id, title });
  }
  for (const [key, p] of pagesOnPage()) {
    const k = "page:" + key; if (sentLinks.has(k)) continue; sentLinks.add(k); pages.push(p);
  }
  for (const p of boxCountryPages()) {                 // отдельные вкладки стран box
    const k = "page:" + p.filmId + ":" + p.section; if (sentLinks.has(k)) continue; sentLinks.add(k); pages.push(p);
  }
  for (const [section, s] of allFilmSections()) {      // самообнаружение типов разделов
    const k = "sect:" + section; if (sentLinks.has(k)) continue; sentLinks.add(k); sections.push(s);
  }
  if (!films.length && !persons.length && !series.length && !pages.length && !sections.length) return;
  chrome.runtime.sendMessage({ type: "discover", films, persons, series, pages, sections }, () => refreshQueue());
}
