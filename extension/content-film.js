/*
 * Краулер Кинопоиска — главная страница фильма.
 * extract() со страницы /film/{id}/ + отправка (send) и планировщик (schedule).
 * Часть content-скрипта (загрузка по порядку из manifest.json, общий isolated-world scope).
 */
// главная фильма: получаем id (синхронно с телом) и его ld, дальше — общий разбор страницы.
function extract() {
  const filmId = consistentId();
  if (!filmId) return null;
  return extractFromPage(filmId, currentLd());
}

// общий разбор Next.js-страницы «энциклопедии» (формат идентичен у фильма и сериала):
// принимает уже подтверждённый id и соответствующий ld (может быть null на SPA-переходе).
// Используется и для /film/, и для /series/ (см. content-series.js).
function extractFromPage(filmId, ld) {
  const table = document.querySelector('[data-test-id="encyclopedic-table"]');
  if (!table) return null;                 // данные ещё не отрисованы

  const row = (tid) => table.querySelector(`[data-test-id="${tid}"]`);
  const rowText = (tid) => {
    const r = row(tid);
    if (!r) return null;
    const val = r.querySelector('[class*="value"]') || r.children[1] || r;
    return clean(val.textContent) || null;
  };
  const rowPersons = (tid) => {
    const r = row(tid);
    if (!r) return [];
    const seen = new Set();
    const out = [];
    for (const a of r.querySelectorAll('a[href*="/name/"]')) {
      const id = idFromName(a.getAttribute("href"));
      const name = clean(a.textContent);
      if (!name || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name });
    }
    return out;
  };

  // заголовок "Название (Год)"
  const h1 = document.querySelector('h1[itemprop="name"]') || document.querySelector("h1");
  const h1txt = h1 ? clean(h1.textContent) : "";
  const ym = h1txt.match(/\((\d{4})\)\s*$/);
  const titleH1 = h1txt.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  const origEl = document.querySelector('[class*="originalTitle"]');

  // актёры — микроразметка itemprop="actor"
  const actors = [];
  {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[itemprop="actor"][href*="/name/"]')) {
      const id = idFromName(a.getAttribute("href"));
      const name = clean(a.textContent);
      if (!id || seen.has(id) || !name) continue;
      seen.add(id);
      actors.push({ id, name });
    }
  }

  // рейтинг — виджет (или ld при полной загрузке)
  const rv = document.querySelector('[data-tid="kp-movie-rating.rating-value"]');
  const rc = document.querySelector('button[aria-label*="оцен"]');
  const ratingValue = ld && ld.aggregateRating ? num(ld.aggregateRating.ratingValue)
    : rv ? num(clean(rv.textContent).replace(",", ".")) : null;
  const ratingCount = ld && ld.aggregateRating ? num(ld.aggregateRating.ratingCount)
    : rc ? num((rc.getAttribute("aria-label") || "").replace(/[\s ]/g, "")) : null;

  // IMDb (.film-sub-rating: «IMDb: 6.50» + «262 000 оценок»). Якоря семантические/по подстроке класса.
  let imdb = null;
  {
    const sub = document.querySelector(".film-sub-rating");
    if (sub) {
      const vs = sub.querySelector('[class*="valueSection"]');
      const mm = vs ? clean(vs.textContent).match(/imdb[:\s]*([\d.,]+)/i) : null;
      const cEl = sub.querySelector('[class*="count"]');
      const count = cEl ? num(clean(cEl.textContent).replace(/[\s ]/g, "")) : null;
      if (mm) imdb = { value: num(mm[1].replace(",", ".")), count };
    }
  }

  // рейтинг кинокритиков (criticRatingSection): мир + РФ. Каждый «бар» — h3 + полосы + значение.
  const critics = [];
  {
    const sec = document.querySelector('[class*="criticRatingSection"]');
    if (sec) {
      for (const h3 of sec.querySelectorAll("h3")) {
        const block = h3.parentElement;
        if (!block) continue;
        const label = clean(h3.textContent);
        const scope = /мире/i.test(label) ? "world" : /росси/i.test(label) ? "ru" : label;
        const valEl = block.querySelector('.film-rating-value [aria-hidden="true"]');
        const green = block.querySelector('[class*="greenBar"]');
        const red = block.querySelector('[class*="redBar"]');
        const cb = block.querySelector('[class*="countBlock"]');
        const star = block.querySelector('[class*="starValue"]');
        critics.push({
          scope, label,
          pct: valEl ? num(clean(valEl.textContent)) : null,
          count: cb ? num(clean(cb.textContent).replace(/[\s ]/g, "")) : null,
          avg: star ? num(clean(star.textContent).replace(",", ".")) : null,
          positive: green && clean(green.textContent) ? num(clean(green.textContent)) : null,
          negative: red && clean(red.textContent) ? num(clean(red.textContent)) : 0,
        });
      }
    }
  }

  // описание: ld (полное) или meta[name=description] (обновляется на SPA), без ведущего эмодзи
  const description =
    (ld ? clean(ld.description) : null) ||
    (metaContent('meta[name="description"]') || "").replace(/^[^0-9A-Za-zА-Яа-яЁё]+/, "").trim() || null;

  // постер — ссылка (ld.image или og:image); data:-бинарь не берём
  const posterRaw = (ld && ld.image) || metaContent('meta[property="og:image"]');
  const poster = typeof posterRaw === "string" && !/^data:/i.test(posterRaw) ? posterRaw : null;

  // самообнаружение: все строки таблицы (прямые потомки)
  const allTable = {};
  for (const r of table.querySelectorAll(":scope > [data-test-id]")) {
    const k = r.getAttribute("data-test-id");
    if (!k) continue;
    const v = r.querySelector('[class*="value"]') || r.children[1];
    allTable[k] = clean((v || r).textContent);
  }

  return {
    id: filmId,
    title: titleH1 || (ld ? clean(ld.name) : null) || null,
    titleOrig: (origEl ? clean(origEl.textContent) : "") || (ld ? clean(ld.alternateName) : "") || null,
    year: (ym ? Number(ym[1]) : null) || num(rowText("year")) || (ld ? num(ld.datePublished) : null),
    slogan: rowText("tagline"),
    originals: rowText("originals"),     // «Первоисточник» (на чём основан фильм), напр. «DC Universe»
    genres: (rowText("genres") || "").split(",").map(clean).filter(Boolean),
    countries: (rowText("countries") || "").split(",").map(clean).filter(Boolean),
    duration: (ld ? num(ld.timeRequired) : null) || parseMinutes(rowText("duration")),
    ageRestriction: rowText("ageRestriction"),
    ratingMPAA: rowText("ratingMPAA") || (ld ? clean(ld.contentRating) : null),
    rating: ratingValue != null || ratingCount != null ? { value: ratingValue, count: ratingCount } : null,
    imdb,
    critics: critics.length ? critics : null,
    description,
    poster,
    crew: {
      directors: rowPersons("directors"),
      writers: rowPersons("writers"),
      producers: rowPersons("producers"),
      operators: rowPersons("operators"),
      composers: rowPersons("composers"),
      designers: rowPersons("designers"),
      editors: rowPersons("filmEditors"),
    },
    actors,
    boxOffice: {
      budget: rowText("budget"),
      marketing: rowText("marketing"),
      usa: rowText("usaBox"),
      world: (rowText("worldBox") || "").replace(/сборы.*$/i, "").trim() || null,
      rus: rowText("rusBox"),
    },
    audience: rowText("audience"),
    premieres: { ru: rowText("ruPremiere"), world: rowText("worldPremieres"), dvd: rowText("dvdRelease") },
    releases: {
      bluray: rowText("blueRayRelease"),
      digital: rowText("digitalRelease"),
      re: rowText("reRelease"),
    },
    source: { url: location.href.split("?")[0] },
    _allTable: allTable,
    _ld: sanitizeLd(ld),  // null на SPA-переходе (ld устаревший не пишем)
  };
}

// ---------- отправка фильма ----------
// оптимистично: исходник (ensureHtmlSaved) и запись фильма летят параллельно; ✓/↻ только если оба ок
async function send(movie) {
  setBadge(`⏳ запись #${movie.id}…`, "#b8860b");
  const htmlP = ensureHtmlSaved();
  const resp = await sendMsg({ type: "movie", movie });
  const htmlOk = await htmlP;
  dbg("ответ по #" + movie.id + ":", resp, "htmlOk:", htmlOk);
  const r = resp && resp.ok && resp.result;
  if (!r || !htmlOk) {
    SEEN.delete(movie.id); // повтор на следующем тике (записи идемпотентны)
    setBadge(`✗ ошибка записи #${movie.id}`, "#cf222e");
    console.warn("[kp] ошибка записи", movie.id, { dataOk: !!r, htmlOk, error: resp && resp.error });
    return;
  }
  KNOWN_DB.add(movie.id);
  lastStatus = { id: movie.id, title: movie.title, isNew: r.isNew, firstSeen: r.firstSeen };
  if (r.isNew) setBadge(`✓ #${movie.id} записан · ${movie.title}`, "#1a7f37");
  else {
    const d = r.firstSeen ? new Date(r.firstSeen).toLocaleDateString("ru-RU") : "";
    setBadge(`↻ #${movie.id} обновлён · был ${d}`, "#0969da");
  }
  console.log(`%c[kp] ${r.isNew ? "✓ записан" : "↻ обновлён"} #${movie.id} — ${movie.title}`, "color:green");
  if (r.newAttrs && r.newAttrs.length)
    console.warn("[kp] 🆕 впервые встречены атрибуты:", r.newAttrs.join(", "));
  refreshQueue(); // фильм ушёл из очереди + перерисуем постоянный список нерешённых атрибутов
}

let debounce = null;
let _lastPath = location.pathname;
function schedule() {
  if (location.pathname !== _lastPath) {
    dbg("nav:", _lastPath, "→", location.pathname);
    _lastPath = location.pathname;
  }
  const path = location.pathname;
  const isMain = /^\/film\/\d+\/?$/.test(path);        // только ГЛАВНАЯ страница фильма
  const urlId = idFromFilm(path);
  const id = isMain ? consistentId() : null;
  if (!id) {
    // подстраницы фильма (/cast/ и т.п.) не трогаем — их статусом управляют свои обработчики
    if (!isMain && !/^\/film\/\d+\/.+/.test(path)) setBadge("", "#555");
    else if (isMain && !SEEN.has(urlId)) setBadge("⏳ загрузка фильма…", "#555");
    // диагностика «вечного ожидания» — только на главной фильма
    const now = Date.now();
    if (isMain && now - _lastWaitLog > 2000) {
      _lastWaitLog = now;
      dbg("ждём синхронизации: url id =", urlId,
          "| ld Movie на странице:", movieLds().map((l) => idFromFilm(l.url)));
    }
    return;
  }
  if (SEEN.has(id)) return;
  dbg("готов id =", id, "— планирую отправку");
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    const id2 = consistentId();
    if (!id2 || id2 !== id || SEEN.has(id2)) { dbg("отмена отправки", { id, id2, seen: SEEN.has(id2) }); return; }
    const movie = extract();
    if (!movie || movie.id !== id2) { dbg("отмена: extract вернул", movie && movie.id); return; }
    SEEN.add(id2);
    dbg("отправляю #" + id2);
    send(movie);
  }, 600);
}
