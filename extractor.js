/*
 * Kinopoisk movie extractor — прототип для консоли браузера.
 *
 * Использование:
 *   1. Открой страницу фильма, напр. https://www.kinopoisk.ru/film/78871/
 *   2. F12 → Console → вставь весь этот файл, Enter.
 *   3. JSON фильма выведется в консоль и скопируется в буфер (copy()).
 *      Сохрани его в MOVIES/{id}.json.
 *
 * Опирается на стабильные якоря: ld+json (schema.org) + data-test-id таблицы.
 * Классы (styles_xxx) НЕ используются — они захешированы и меняются.
 */
(function () {
  const clean = (s) =>
    (s || "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // --- ID фильма из URL ---
  const filmId = Number((location.pathname.match(/\/film\/(\d+)/) || [])[1]) || null;

  // --- ld+json (schema.org Movie) ---
  let ld = {};
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const o = JSON.parse(s.textContent);
      if (o && o["@type"] === "Movie") { ld = o; break; }
    } catch (_) {}
  }

  const personUrlId = (url) => {
    const m = (url || "").match(/\/name\/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const ldPersons = (arr) =>
    (arr || []).map((p) => ({ id: personUrlId(p.url), name: clean(p.name) }));

  // --- таблица «О фильме»: строка по data-test-id ---
  const row = (tid) =>
    document.querySelector(`[data-test-id="encyclopedic-table"] [data-test-id="${tid}"]`);
  const rowText = (tid) => {
    const r = row(tid);
    if (!r) return null;
    // значение — второй div строки
    const val = r.querySelector('[class*="value"]') || r.children[1] || r;
    return clean(val.textContent) || null;
  };
  // персоны из строки (по ссылкам /name/ID/) — даёт id+name, минует «…ещё N»
  const rowPersons = (tid) => {
    const r = row(tid);
    if (!r) return [];
    const seen = new Set();
    const out = [];
    for (const a of r.querySelectorAll('a[href*="/name/"]')) {
      const id = personUrlId(a.getAttribute("href"));
      const name = clean(a.textContent);
      if (!name || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name });
    }
    return out;
  };

  const num = (v) => (v == null || v === "" ? null : Number(v));

  const movie = {
    id: filmId,
    title: clean(ld.name) || null,
    titleOrig: clean(ld.alternateName) || null,
    year: num(ld.datePublished) || num(rowText("year")),
    slogan: rowText("tagline"),
    genres: ld.genre || (rowText("genres") || "").split(",").map(clean).filter(Boolean),
    countries:
      ld.countryOfOrigin ||
      (rowText("countries") || "").split(",").map(clean).filter(Boolean),
    duration: num(ld.timeRequired) || num((rowText("duration") || "").match(/\d+/)),
    ageRestriction: rowText("ageRestriction"),
    ratingMPAA: clean(ld.contentRating) || rowText("ratingMPAA"),
    rating: ld.aggregateRating
      ? {
          value: num(ld.aggregateRating.ratingValue),
          count: num(ld.aggregateRating.ratingCount),
        }
      : null,
    description: clean(ld.description),
    poster: (typeof ld.image === "string" && !/^data:/i.test(ld.image)) ? ld.image : null,
    crew: {
      directors: rowPersons("directors").length
        ? rowPersons("directors")
        : ldPersons(ld.director),
      writers: rowPersons("writers"),
      producers: rowPersons("producers"),
      operators: rowPersons("operators"),
      composers: rowPersons("composers"),
      designers: rowPersons("designers"),
      editors: rowPersons("filmEditors"),
    },
    actors: ldPersons(ld.actor),
    boxOffice: {
      budget: rowText("budget"),
      marketing: rowText("marketing"),
      usa: rowText("usaBox"),
      world: (rowText("worldBox") || "").replace(/сборы.*$/i, "").trim() || null,
      rus: rowText("rusBox"),
    },
    audience: rowText("audience"),
    premieres: {
      ru: rowText("ruPremiere"),
      world: rowText("worldPremieres"),
      dvd: rowText("dvdRelease"),
    },
    releases: {
      bluray: rowText("blueRayRelease"),
      digital: rowText("digitalRelease"),
      re: rowText("reRelease"),
    },
    source: { url: location.href.split("?")[0] },
  };

  const json = JSON.stringify(movie, null, 2);
  console.log(json);
  try { copy(movie); console.log("%c✓ скопировано в буфер (copy)", "color:green"); } catch (_) {}
  window.__movie = movie;
  return movie;
})();
