/*
 * Content script Кинопоиск-краулера.
 *  - извлекает данные фильма (логика = корневой extractor.js) и шлёт писателю;
 *  - снимает ВСЕ строки таблицы + ключи ld+json для самообнаружения новых атрибутов;
 *  - показывает бейдж статуса (записан/обновлён + ID);
 *  - подсвечивает ссылки на уже посещённые фильмы (есть в БД);
 *  - даёт консольный API window.kp (status/links/go).
 */
(function () {
  const SEEN = new Set();        // фильмы, отправленные в этой сессии
  const KNOWN_DB = new Set();    // фильмы, найденные в БД (для подсветки)
  const asked = new Set();       // id, по которым уже спрашивали /known
  let lastStatus = null;

  const clean = (s) =>
    (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const idFromName = (u) => {
    const m = (u || "").match(/\/name\/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const idFromFilm = (u) => {
    const m = (u || "").match(/\/film\/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const DEBUG = true;
  const dbg = (...a) => { if (DEBUG) console.log("%c[kp]", "color:#888", ...a); };
  let _lastWaitLog = 0;

  // все ld+json типа Movie на странице (при SPA-переходе их может быть несколько)
  const movieLds = () => {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const o = JSON.parse(s.textContent);
        if (o && o["@type"] === "Movie") out.push(o);
      } catch (_) {}
    }
    return out;
  };
  // ld, СООТВЕТСТВУЮЩИЙ текущему адресу (а не первый попавшийся — иначе виснем на старом)
  const currentLd = () => {
    const urlId = idFromFilm(location.pathname);
    if (!urlId) return null;
    for (const ld of movieLds()) if (idFromFilm(ld.url) === urlId) return ld;
    return null;
  };
  // полный ld для raw (потерь нет, возвращаться за атрибутами не придётся):
  // убираем постер (решение №6) и встроенный бинарь (data:-URI), ссылки оставляем.
  const sanitizeLd = (ld) => {
    if (!ld) return null;
    const o = JSON.parse(JSON.stringify(ld));
    delete o.image;
    const strip = (v) => {
      if (typeof v === "string") return /^data:/i.test(v) ? null : v;
      if (Array.isArray(v)) return v.map(strip).filter((x) => x !== null);
      if (v && typeof v === "object") {
        for (const k of Object.keys(v)) {
          const r = strip(v[k]);
          if (r === null) delete v[k]; else v[k] = r;
        }
      }
      return v;
    };
    return strip(o);
  };

  // id текущего фильма по ТЕЛУ страницы (надёжно на SPA: ld+json не обновляется при переходе).
  // Ссылка "/film/ID/cast/" принадлежит текущему фильму; запасной якорь — canonical.
  function domFilmId() {
    for (const a of document.querySelectorAll('a[href*="/cast"]')) {
      const m = (a.getAttribute("href") || "").match(/\/film\/(\d+)\/cast/);
      if (m) return Number(m[1]);
    }
    const can = document.querySelector('link[rel="canonical"], meta[property="og:url"]');
    if (can) return idFromFilm(can.getAttribute("href") || can.getAttribute("content"));
    return null;
  }

  // готовы извлекать только когда ТЕЛО страницы соответствует адресу
  function consistentId() {
    const urlId = idFromFilm(location.pathname);
    return urlId && domFilmId() === urlId ? urlId : null;
  }

  const num = (v) => {
    if (v == null || v === "") return null;
    const d = String(v).match(/\d+(\.\d+)?/);
    return d ? Number(d[0]) : null;
  };
  // хронометраж в минутах: «2 ч 5 мин» → 125, «125 мин» → 125, «125» → 125
  const parseMinutes = (s) => {
    if (!s) return null;
    const hm = String(s).match(/(\d+)\s*ч/);
    const mm = String(s).match(/(\d+)\s*мин/);
    if (hm || mm) return (hm ? +hm[1] : 0) * 60 + (mm ? +mm[1] : 0);
    return num(s);
  };
  const metaContent = (sel) => {
    const el = document.querySelector(sel);
    return el ? clean(el.getAttribute("content")) : null;
  };

  function extract() {
    const filmId = consistentId();
    if (!filmId) return null;
    const table = document.querySelector('[data-test-id="encyclopedic-table"]');
    if (!table) return null;                 // данные ещё не отрисованы
    const ld = currentLd();                  // не null только при полной загрузке (совпал с адресом)

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

  // ---------- панель: очередь (+ переобход) + статус ----------
  let panel, elQueue, elNew, elStatus;
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "kp-crawler-panel";
    Object.assign(panel.style, {
      position: "fixed", zIndex: 2147483647, right: "12px", bottom: "12px",
      width: "300px", maxHeight: "60vh", overflow: "auto", padding: "8px 10px",
      borderRadius: "8px", font: "12px/1.4 -apple-system,sans-serif", color: "#fff",
      background: "rgba(28,28,30,.95)", boxShadow: "0 2px 12px rgba(0,0,0,.45)",
    });
    elQueue = document.createElement("div");
    elNew = document.createElement("div");
    elStatus = document.createElement("div");
    Object.assign(elNew.style, {
      marginTop: "8px", padding: "6px 8px", borderRadius: "6px",
      background: "#9a6700", color: "#fff", display: "none", whiteSpace: "normal",
    });
    Object.assign(elStatus.style, {
      marginTop: "8px", padding: "6px 8px", borderRadius: "6px", background: "#555",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    });
    panel.appendChild(elQueue);
    panel.appendChild(elNew);
    panel.appendChild(elStatus);
    (document.body || document.documentElement).appendChild(panel);
    return panel;
  }
  function setNewAttrs(list) {
    ensurePanel();
    if (list && list.length) {
      elNew.textContent = `🆕 новые атрибуты: ${list.join(", ")}`;
      elNew.style.display = "block";
    } else {
      elNew.style.display = "none";
    }
  }
  const inPanel = (el) => panel && panel.contains(el);
  function setBadge(text, bg) {
    ensurePanel();
    elStatus.textContent = text || "";
    elStatus.style.display = text ? "block" : "none";
    elStatus.style.background = bg || "#555";
  }
  const esc = (s) => (s || "(без названия)").replace(/[<>&]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const linkRow = (f, color, mark) =>
    `<a href="/film/${f.id}/" style="display:block;color:${color};text-decoration:none;padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${mark}#${f.id} — ${esc(f.title)}</a>`;
  function renderQueue(data) {
    ensurePanel();
    const films = (data && data.films) || [];
    const recrawl = (data && data.recrawl) || [];
    if (!films.length && !recrawl.length) {
      elQueue.innerHTML = '<div style="opacity:.6">очередь пуста</div>';
      return;
    }
    let html = "";
    if (films.length) {
      html += `<div style="opacity:.7;margin-bottom:4px">Очередь — новые фильмы (${films.length}):</div>`;
      for (const f of films) html += linkRow(f, "#7cc4ff", "");
    }
    if (recrawl.length) {
      html += `<div style="opacity:.7;margin:6px 0 4px;padding-top:6px;border-top:1px solid rgba(255,255,255,.15)">↻ Переобход — добор новых полей (${recrawl.length}):</div>`;
      for (const f of recrawl) html += linkRow(f, "#ffb454", "↻ ");
    }
    elQueue.innerHTML = html;
  }
  function refreshQueue() {
    chrome.runtime.sendMessage({ type: "queue" }, (resp) => {
      if (resp && resp.ok && resp.result) renderQueue(resp.result);
    });
  }

  // ---------- отправка фильма ----------
  // оптимистично: исходник (ensureHtmlSaved) и запись фильма летят параллельно; ✓/↻ только если оба ок
  async function send(movie) {
    setNewAttrs([]); // сбросить плашку предыдущего фильма
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
    setNewAttrs(r.newAttrs);
    if (r.newAttrs && r.newAttrs.length)
      console.warn("[kp] 🆕 новые атрибуты:", r.newAttrs.join(", "));
    refreshQueue(); // фильм ушёл из очереди (или из переобхода) — обновим список
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

  // ---------- сбор ссылок на странице (фильмы + персоны) ----------
  // возвращает Map(id -> title|null), пропуская ссылки внутри нашей панели
  function scan(selector, idOf) {
    const m = new Map();
    for (const a of document.querySelectorAll(selector)) {
      if (inPanel(a)) continue;
      const id = idOf(a.getAttribute("href"));
      if (!id) continue;
      const t = clean(a.textContent);
      if (!m.has(id) || (!m.get(id) && t)) m.set(id, t || null);
    }
    return m;
  }
  const filmsOnPage = () => scan('a[href*="/film/"]', idFromFilm);
  const personsOnPage = () => scan('a[href*="/name/"]', idFromName);

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

  // подстраницы фильма (ветки): любая ссылка /film/{id}/<раздел>/... → {filmId, section, url}
  // section = первый сегмент после id (cast, dates, box, studio, keywords, other, …).
  // Захватываем ВСЕ разделы (даже неизвестные/будущие) — чтобы гарантированно ничего не упустить.
  function pagesOnPage() {
    const m = new Map(); // "id:section" -> {filmId, section, url}
    for (const a of document.querySelectorAll('a[href*="/film/"]')) {
      if (inPanel(a)) continue;
      const mm = (a.getAttribute("href") || "").match(/\/film\/(\d+)\/([a-z][a-z0-9_]*)/i);
      if (!mm) continue; // это корень /film/ID/ (сам фильм) — не ветка
      const filmId = Number(mm[1]), section = mm[2].toLowerCase();
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

  // ---------- складирование обнаруженных ссылок в очередь ----------
  const sentLinks = new Set(); // 'film:ID' / 'person:ID' / 'page:ID:section' — уже отправленные
  function sendDiscover() {
    const films = [], persons = [], pages = [];
    for (const [id, title] of filmsOnPage()) {
      const k = "film:" + id; if (sentLinks.has(k)) continue; sentLinks.add(k); films.push({ id, title });
    }
    for (const [id, title] of personsOnPage()) {
      const k = "person:" + id; if (sentLinks.has(k)) continue; sentLinks.add(k); persons.push({ id, title });
    }
    for (const [key, p] of pagesOnPage()) {
      const k = "page:" + key; if (sentLinks.has(k)) continue; sentLinks.add(k); pages.push(p);
    }
    for (const p of boxCountryPages()) {                 // отдельные вкладки стран box
      const k = "page:" + p.filmId + ":" + p.section; if (sentLinks.has(k)) continue; sentLinks.add(k); pages.push(p);
    }
    if (!films.length && !persons.length && !pages.length) return;
    chrome.runtime.sendMessage({ type: "discover", films, persons, pages }, () => refreshQueue());
  }

  // ---------- полный каст: /film/{id}/cast/ ----------
  // секции помечены <a name="ROLE">; персоны — блоки .dub с .name a[/name/] и .role (персонаж).
  const CAST_ROLEMAP = {
    director: "directors", writer: "writers", producer: "producers",
    operator: "operators", composer: "composers", design: "designers",
    editor: "editors", actor: "actor",
    voice: "voice", voice_director: "voice_director", translator: "translator",
  };
  const SENT_CAST = new Set();

  function extractCast() {
    const m = location.pathname.match(/^\/film\/(\d+)\/cast\/?$/);
    if (!m) return null;
    const filmId = Number(m[1]);
    const nodes = document.querySelectorAll("a[name], .dub");
    if (!nodes.length) return null;
    let role = null;
    const ord = {};
    const credits = [];
    for (const el of nodes) {
      if (el.matches("a[name]")) {
        const raw = el.getAttribute("name");
        role = CAST_ROLEMAP[raw] || raw;            // неизвестную секцию берём как есть (не пропускаем)
        continue;
      }
      if (!role) continue;
      const a = el.querySelector('.name a[href*="/name/"]');
      if (!a) continue;
      const id = idFromName(a.getAttribute("href"));
      if (!id) continue;
      const grayEl = el.querySelector(".name .gray");
      const roleEl = el.querySelector(".role");
      const character = roleEl
        ? clean(roleEl.textContent).replace(/^[.…]+\s*/, "").trim() || null
        : null;
      ord[role] = ord[role] || 0;
      credits.push({
        id, name: clean(a.textContent),
        nameOrig: grayEl ? clean(grayEl.textContent) : null,
        role, character, ord: ord[role]++,
      });
    }
    return credits.length ? { filmId, credits } : null;
  }

  function maybeSendCast() {
    const m = location.pathname.match(/^\/film\/(\d+)\/cast\/?$/);
    if (!m) return;
    const filmId = Number(m[1]);
    if (SENT_CAST.has(filmId)) return;
    const data = extractCast();
    if (!data) return;
    commitPage(SENT_CAST, filmId,
      `⏳ каст #${filmId}…`,
      `✓ каст #${filmId}: ${data.credits.length} чел.`,
      `✗ каст #${filmId}`,
      { type: "cast", filmId, credits: data.credits },
      `✓ каст #${filmId} — ${data.credits.length} участников`);
  }

  // ---------- даты: /film/{id}/dates/ ----------
  const RU_MONTHS = {
    января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
    июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
  };
  const parseRuDate = (s) => {
    const m = (s || "").match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
    if (!m) return null;
    const mo = RU_MONTHS[m[2].toLowerCase()];
    if (!mo) return null;
    return `${m[3]}-${String(mo).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  };
  const SENT_DATES = new Set();

  function extractDates() {
    const mm = location.pathname.match(/^\/film\/(\d+)\/dates\/?$/);
    if (!mm) return null;
    const filmId = Number(mm[1]);
    const out = [];
    let ord = 0;
    for (const tr of document.querySelectorAll("tr")) {
      if (tr.querySelector("tr")) continue;             // строка-обёртка секции — пропуск
      const flag = tr.querySelector("div.flag");
      const b = tr.querySelector("td.news b");
      if (!flag || !b) continue;                        // не строка даты
      const dateText = clean(b.textContent);
      if (!dateText) continue;
      const link = tr.querySelector('a[href*="country"]');
      const country = link ? clean(link.textContent) : null;
      let countryId = null;
      if (link) { const x = (link.getAttribute("href") || "").match(/(\d+)/); if (x) countryId = Number(x[1]); }
      if (countryId == null) { const f = (flag.className || "").match(/flag(\d+)/); if (f) countryId = Number(f[1]); }
      const smalls = tr.querySelectorAll("small");
      const type = smalls[0] ? clean(smalls[0].textContent) : "";  // per-row: ''=премьера, иначе «Переиздание»/«Интернет»/…
      const note = smalls[1] ? clean(smalls[1].textContent) : "";  // доп.: зрители/прокатчик
      out.push({
        ord: ord++, dateText, date: parseRuDate(dateText),
        countryId, country, type: type || null, note: note || null,
      });
    }
    return out.length ? { filmId, dates: out } : null;
  }

  function maybeSendDates() {
    const mm = location.pathname.match(/^\/film\/(\d+)\/dates\/?$/);
    if (!mm) return;
    const filmId = Number(mm[1]);
    if (SENT_DATES.has(filmId)) return;
    const data = extractDates();
    if (!data) return;
    commitPage(SENT_DATES, filmId,
      `⏳ даты #${filmId}…`,
      `✓ даты #${filmId}: ${data.dates.length} зап.`,
      `✗ даты #${filmId}`,
      { type: "dates", filmId, dates: data.dates },
      `✓ даты #${filmId} — ${data.dates.length} записей`);
  }

  // ---------- сборы: /film/{id}/box/ (+ вкладки стран /box/<country>/) ----------
  // Классический формат: 4+ секции, заголовок каждой — <b> в td[style*="#f60"];
  // строки = пары «label (<b>) → value (<h3>)»; pct — второй <h3> с «%», note — <small>.
  // Снимаем КАЖДУЮ строку (как discovered_attrs) — ничего не теряем, триаж потом.
  const SENT_BOX = new Set();                 // дедуп по "filmId:tab"
  const boxAmount = (v) => {
    if (!v) return null;
    if (/\d{1,2}\.\d{1,2}\.\d{4}/.test(v)) return null;   // это дата, не сумма
    const digits = (clean(v).match(/\d[\d ]*/) || [""])[0].replace(/\D/g, "");
    return digits ? Number(digits) : null;
  };

  function extractBox() {
    const m = location.pathname.match(/^\/film\/(\d+)\/box(?:\/[a-z]+)?\/?$/);
    if (!m) return null;
    const filmId = Number(m[1]);
    const root = document.querySelector(".block_left") || document;
    const tabEl = root.querySelector(".insert li.act");
    const tab = (tabEl ? clean(tabEl.textContent) : "") || "США";
    const headers = root.querySelectorAll('td[style*="#f60"] b');  // заголовки секций
    if (!headers.length) return null;
    const rows = [];
    let ord = 0;
    const seenTables = new Set();
    for (const hb of headers) {
      const headTd = hb.closest("td");
      const tableEl = hb.closest("table");
      if (!tableEl || seenTables.has(tableEl)) continue;
      seenTables.add(tableEl);
      const section = clean(hb.textContent);
      let label = null;
      for (const tr of tableEl.querySelectorAll("tr")) {
        if (headTd && tr.contains(headTd)) continue;        // строка-заголовок секции
        const h3s = tr.querySelectorAll("h3");
        if (h3s.length) {
          const value = clean(h3s[0].textContent);
          if (!value) continue;
          let pct = null;
          for (let i = 1; i < h3s.length; i++) {
            const t = clean(h3s[i].textContent);
            if (t.includes("%")) { const n = parseFloat(t.replace("%", "").replace(",", ".")); if (isFinite(n)) pct = n; }
          }
          const note = [...tr.querySelectorAll("small")].map((s) => clean(s.textContent)).filter(Boolean).join(" ") || null;
          rows.push({
            ord: ord++, section, label, value,
            amount: boxAmount(value),
            currency: value.includes("$") ? "$" : /руб/i.test(value) ? "руб." : /€/.test(value) ? "€" : null,
            pct, note,
          });
        } else {
          const b = tr.querySelector("b");
          if (b) label = clean(b.textContent).replace(/:\s*$/, "");
        }
      }
    }
    return rows.length ? { filmId, tab, rows } : null;
  }

  function maybeSendBox() {
    const m = location.pathname.match(/^\/film\/(\d+)\/box(?:\/[a-z]+)?\/?$/);
    if (!m) return;
    const data = extractBox();
    if (!data) return;
    const key = data.filmId + ":" + data.tab;
    if (SENT_BOX.has(key)) return;
    commitPage(SENT_BOX, key,
      `⏳ сборы #${data.filmId} (${data.tab})…`,
      `✓ сборы #${data.filmId} (${data.tab}): ${data.rows.length} стр.`,
      `✗ сборы #${data.filmId}`,
      { type: "box", filmId: data.filmId, tab: data.tab, rows: data.rows },
      `✓ сборы #${data.filmId} (${data.tab}) — ${data.rows.length} строк`);
  }

  // ---------- студии/тех.данные: /film/{id}/studio/ ----------
  // Классический формат. Две части:
  //  1) тех. характеристики (верхний блок td[style*="tech-bg"]): label(<b>)→value, многозначные
  //     (строки-продолжения с пустым <b> наследуют предыдущий label);
  //  2) компании по секциям (<b> в td[style*="#f60"]): Производство/Спецэффекты/Студия дубляжа/Прокат/…,
  //     каждая компания = a[href*="/lists/m_act[studio]/ID/"] + note (font#999999).
  const STUDIO_ROLEMAP = {
    "Производство": "production", "Спецэффекты": "effects",
    "Студия дубляжа": "dubbing", "Прокат": "distribution",
  };
  const SENT_STUDIO = new Set();

  function extractStudio() {
    const m = location.pathname.match(/^\/film\/(\d+)\/studio\/?$/);
    if (!m) return null;
    const filmId = Number(m[1]);
    const root = document.querySelector(".block_left") || document;

    // 1) тех. характеристики
    const tech = [];
    const techTable = (() => {
      const td = root.querySelector('td[style*="tech-bg"]');
      return td ? td.querySelector("table") : null;
    })();
    if (techTable) {
      let last = null, ord = 0;
      for (const tr of techTable.querySelectorAll("tr")) {
        const tds = tr.querySelectorAll(":scope > td");
        if (tds.length < 2) continue;
        let label = clean(tds[0].textContent).replace(/:\s*$/, "");
        const value = clean(tds[1].textContent);
        if (!label) label = last; else last = label;
        if (!value) continue;
        tech.push({ ord: ord++, label: label || null, value });
      }
    }

    // 2) компании по секциям
    const studios = [];
    const seenTables = new Set();
    for (const hb of root.querySelectorAll('td[style*="#f60"] b')) {
      const tableEl = hb.closest("table");
      if (!tableEl || seenTables.has(tableEl)) continue;
      seenTables.add(tableEl);
      const raw = clean(hb.textContent).replace(/:\s*$/, "");
      const role = STUDIO_ROLEMAP[raw] || raw;
      let ord = 0;
      for (const a of tableEl.querySelectorAll('a[href*="/lists/m_act"]')) {
        const href = a.getAttribute("href") || "";
        // m_act[studio]/35/, m_act[company]/341/, m_act[company_en]/warnerbros/ — разные namespace
        const km = href.match(/m_act\[([a-z_]+)\]\/([^/]+)\//i);
        const kind = km ? km[1].toLowerCase() : null;
        const ref = km ? km[2] : null;                       // сырой идентификатор (число или слаг)
        const name = clean(a.textContent);
        if (!name) continue;
        const td = a.closest("td");
        const fontEl = td ? td.querySelector("font") : null; // описание (эффекты) или страна (прокат)
        const note = fontEl ? clean(fontEl.textContent) : "";
        studios.push({
          role, ord: ord++,
          companyKind: kind, companyRef: ref,
          companyId: ref && /^\d+$/.test(ref) ? Number(ref) : null,
          name, note: note || null,
        });
      }
    }

    return (tech.length || studios.length) ? { filmId, tech, studios } : null;
  }

  function maybeSendStudio() {
    const m = location.pathname.match(/^\/film\/(\d+)\/studio\/?$/);
    if (!m) return;
    const filmId = Number(m[1]);
    if (SENT_STUDIO.has(filmId)) return;
    const data = extractStudio();
    if (!data) return;
    commitPage(SENT_STUDIO, filmId,
      `⏳ студии #${filmId}…`,
      `✓ студии #${filmId}: ${data.studios.length} комп., ${data.tech.length} тех.`,
      `✗ студии #${filmId}`,
      { type: "studio", filmId, tech: data.tech, studios: data.studios },
      `✓ студии #${filmId} — ${data.studios.length} компаний, ${data.tech.length} тех.строк`);
  }

  // ---------- связанные фильмы: /film/{id}/other/ ----------
  // Классический формат. Секции — заголовок `td.main_line` (#f60): «Продолжение», «Спин-офф»,
  // «Отсылки к», «Спародирован в», «Упоминается в», «Смонтировано в», … (типы варьируются).
  // Заголовок и его фильмы лежат в ОДНОЙ таблице; фильм — `div.item` со `span.name a[/film/ID/]`
  // (назв.+год) и `span.role` (оригинал). Тип связи = сырой текст заголовка (нормализуем потом).
  const SENT_OTHER = new Set();
  const yearFrom = (t) => { const m = (t || "").match(/(\d{4})\)/); return m ? Number(m[1]) : null; };

  function extractOther() {
    const m = location.pathname.match(/^\/film\/(\d+)\/other\/?$/);
    if (!m) return null;
    const filmId = Number(m[1]);
    const rels = [];
    const seenTables = new Set();
    for (const head of document.querySelectorAll("td.main_line")) {
      const relation = clean(head.textContent);
      if (!relation) continue;
      const tableEl = head.closest("table");
      if (!tableEl || seenTables.has(tableEl)) continue;
      seenTables.add(tableEl);
      let ord = 0;
      for (const item of tableEl.querySelectorAll("div.item")) {
        const a = item.querySelector('span.name a[href*="/film/"]');
        if (!a) continue;
        const rid = idFromFilm(a.getAttribute("href"));
        const title = clean(a.textContent);
        const roleEl = item.querySelector("span.role");
        rels.push({
          relation, ord: ord++, relatedId: rid,
          title: title || null,
          titleOrig: roleEl ? clean(roleEl.textContent) || null : null,
          year: yearFrom(title),
        });
      }
    }
    return rels.length ? { filmId, relations: rels } : null;
  }

  function maybeSendOther() {
    const m = location.pathname.match(/^\/film\/(\d+)\/other\/?$/);
    if (!m) return;
    const filmId = Number(m[1]);
    if (SENT_OTHER.has(filmId)) return;
    const data = extractOther();
    if (!data) return;
    commitPage(SENT_OTHER, filmId,
      `⏳ связи #${filmId}…`,
      `✓ связи #${filmId}: ${data.relations.length}`,
      `✗ связи #${filmId}`,
      { type: "other", filmId, relations: data.relations },
      `✓ связи #${filmId} — ${data.relations.length} фильмов`);
  }

  // ---------- ключевые слова: /film/{id}/keywords/ ----------
  // Классический формат. `ul.keywordsList > li > span > a[/lists/m_act[keyword]/ID/]`,
  // текст слова — в атрибуте data-real-keyword (запасной — текст ссылки).
  const SENT_KW = new Set();

  function extractKeywords() {
    const m = location.pathname.match(/^\/film\/(\d+)\/keywords\/?$/);
    if (!m) return null;
    const filmId = Number(m[1]);
    const kws = [];
    let ord = 0;
    for (const a of document.querySelectorAll("a[data-real-keyword][href*='m_act']")) {
      const href = a.getAttribute("href") || "";
      const idm = href.match(/m_act\[keyword\]\/(\d+)/);
      const keyword = clean(a.getAttribute("data-real-keyword") || a.textContent);
      if (!keyword) continue;
      kws.push({ ord: ord++, keywordId: idm ? Number(idm[1]) : null, keyword });
    }
    return kws.length ? { filmId, keywords: kws } : null;
  }

  function maybeSendKeywords() {
    const m = location.pathname.match(/^\/film\/(\d+)\/keywords\/?$/);
    if (!m) return;
    const filmId = Number(m[1]);
    if (SENT_KW.has(filmId)) return;
    const data = extractKeywords();
    if (!data) return;
    commitPage(SENT_KW, filmId,
      `⏳ ключ.слова #${filmId}…`,
      `✓ ключ.слова #${filmId}: ${data.keywords.length}`,
      `✗ ключ.слова #${filmId}`,
      { type: "keywords", filmId, keywords: data.keywords },
      `✓ ключевые слова #${filmId} — ${data.keywords.length}`);
  }

  // ---------- награды/номинации: /film/{id}/awards/ ----------
  // Классический формат (st.kp.yandex.net). Каждая премия — отдельная `<table>` с флагом страны
  // в фоне (`flags/original/XX.png`); заголовок — `td[height=40] b a[/awards/<slug>/<year>/]`
  // («Оскар, 2000 год»). Внутри секции: `<b>Победитель</b>` (оранжевый, result=win) или
  // `<b>Номинации</b>` (result=nomination); далее `ul.trivia > li.trivia` со ссылкой-категорией
  // (`a[href*="#nom"]`) и, опционально, персоной(ами) (`a[/name/ID/]`). Категория с несколькими
  // персонами → одна строка на персону; без персон → строка с person_id=NULL.
  const SENT_AWARDS = new Set();

  function extractAwards() {
    const m = location.pathname.match(/^\/film\/(\d+)\/awards\/?$/);
    if (!m) return null;
    const filmId = Number(m[1]);
    const rows = [];
    let ord = 0;
    const seen = new Set();
    for (const a of document.querySelectorAll('td[height="40"] a[href^="/awards/"]')) {
      const hm = (a.getAttribute("href") || "").match(/^\/awards\/([a-z0-9_]+)\/(\d+)\/$/);
      if (!hm) continue;
      const table = a.closest("table");
      if (!table || seen.has(table)) continue;
      seen.add(table);
      const slug = hm[1];
      const year = Number(hm[2]);
      const name = clean(a.textContent).replace(/,\s*\d{4}\s*год\.?$/i, "");
      const fm = (table.getAttribute("style") || "").match(/flags\/original\/([a-z]+)\.png/);
      const country = fm ? fm[1] : null;
      let result = null;
      for (const td of table.querySelectorAll("td.news")) {
        const b = td.querySelector("b");
        const btxt = b ? clean(b.textContent) : "";
        if (/Победител/i.test(btxt)) result = "win";
        else if (/Номинац/i.test(btxt)) result = "nomination";
        const ul = td.querySelector("ul.trivia");
        if (!ul) continue;
        for (const li of ul.querySelectorAll("li.trivia")) {
          const ca = li.querySelector('a[href*="#nom"]');
          const category = ca ? clean(ca.textContent) : null;
          const nm = ca && (ca.getAttribute("href") || "").match(/#(nom\d+)/);
          const nomId = nm ? nm[1] : null;
          const persons = [...li.querySelectorAll('a[href*="/name/"]')];
          if (persons.length) {
            for (const pa of persons) {
              rows.push({
                ord: ord++, awardSlug: slug, awardName: name, year, country, result,
                category, nomId,
                personId: idFromName(pa.getAttribute("href")),
                personName: clean(pa.textContent) || null,
              });
            }
          } else {
            rows.push({
              ord: ord++, awardSlug: slug, awardName: name, year, country, result,
              category, nomId, personId: null, personName: null,
            });
          }
        }
      }
    }
    return rows.length ? { filmId, awards: rows } : null;
  }

  function maybeSendAwards() {
    const m = location.pathname.match(/^\/film\/(\d+)\/awards\/?$/);
    if (!m) return;
    const filmId = Number(m[1]);
    if (SENT_AWARDS.has(filmId)) return;
    const data = extractAwards();
    if (!data) return;
    commitPage(SENT_AWARDS, filmId,
      `⏳ награды #${filmId}…`,
      `✓ награды #${filmId}: ${data.awards.length}`,
      `✗ награды #${filmId}`,
      { type: "awards", filmId, awards: data.awards },
      `✓ награды #${filmId} — ${data.awards.length} строк`);
  }

  // ---------- персона: /name/{id}/ ----------
  // Формат Next.js (как главная фильма): классы захешированы, якоримся по data-test-id и ld+json.
  // ВАЖНО (как реш. 11): на SPA-переходе ld может остаться от старой персоны → ld берём только при
  // совпадении ld.url с адресом; всё видимое — из DOM (перерисовывается). Текущий id подтверждаем
  // по ссылке-подстранице в теле (`a[href^="/name/ID/<раздел>"]`), а не по ld.
  const SENT_PERSON = new Set();

  const personLd = () => {
    const urlId = idFromName(location.pathname);
    if (!urlId) return null;
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const o = JSON.parse(s.textContent);
        if (o && o["@type"] === "Person" && idFromName(o.url) === urlId) return o;
      } catch (_) {}
    }
    return null;
  };
  // id персоны по ТЕЛУ страницы (вкладки /name/ID/photos|media|relations|awards перерисовываются на SPA)
  const domNameId = () => {
    for (const a of document.querySelectorAll('a[href^="/name/"]')) {
      const m = (a.getAttribute("href") || "").match(/^\/name\/(\d+)\/[a-z]+/);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const noData = (v) => v == null || /^data:/i.test(v) ? null : v;

  function extractPerson() {
    const m = location.pathname.match(/^\/name\/(\d+)\/?$/);
    if (!m) return null;
    const urlId = Number(m[1]);
    if (domNameId() !== urlId) return null;          // тело ещё от старой персоны (SPA) — ждём
    const ld = personLd();                            // null при несовпадении (устаревший ld не берём)

    // все информационные строки (data-test-id с парой title/value) — полный снимок
    const rows = {};
    const rowEl = {};
    for (const el of document.querySelectorAll("div[data-test-id]")) {
      const t = el.querySelector('[class*="styles_title"]');
      const v = el.querySelector('[class*="styles_value"]');
      if (!t || !v) continue;
      const key = el.getAttribute("data-test-id");
      if (!key || key in rows) continue;
      rows[key] = clean(v.textContent);
      rowEl[key] = el;
    }

    const name = clean((document.querySelector('[class*="primaryName"]') || {}).textContent) ||
      (ld && ld.name) || null;
    const nameOrig = clean((document.querySelector('[class*="secondaryName"]') || {}).textContent) ||
      (ld && ld.alternateName) || null;

    // профессии: ld.jobTitle (массив) либо строка «Карьера»
    let professions = Array.isArray(ld && ld.jobTitle) ? ld.jobTitle.slice()
      : (rows.career ? rows.career.split(",") : []);
    professions = professions.map((s) => clean(s)).filter(Boolean);

    const genres = (rows.mainGenres ? rows.mainGenres.split(",") : [])
      .map((s) => clean(s)).filter(Boolean);

    // рост «1.83 м» → см
    let heightCm = null;
    const hm = (rows.height || "").match(/([\d.,]+)\s*м/);
    if (hm) heightCm = Math.round(parseFloat(hm[1].replace(",", ".")) * 100) || null;

    // дата рождения: ISO из ld, иначе разбор строки «11 ноября, 1974»
    let birthDate = (ld && ld.birthDate) || parseRuDate((rows.birthday || "").replace(/,/g, " "));
    const deathDate = parseRuDate((rows.deathday || "").replace(/,/g, " ")) || null;

    // знак зодиака — ссылка zodiac в строке рождения
    let zodiac = null;
    if (rowEl.birthday) {
      const z = rowEl.birthday.querySelector('a[href*="zodiac"]');
      if (z) zodiac = clean(z.textContent) || null;
    }

    const birthPlace = rows.placeOfBirthday || null;

    // всего фильмов + диапазон лет: «285 , 1984 — 2026»
    let filmsTotal = null, careerStart = null, careerEnd = null;
    if (rows.filmographyTotal) {
      const nums = rows.filmographyTotal.match(/\d+/g) || [];
      if (nums[0]) filmsTotal = Number(nums[0]);
      const years = (rows.filmographyTotal.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
      if (years.length) { careerStart = years[0]; careerEnd = years[years.length - 1]; }
    }

    const gender = ld && ld.gender ? (/female/i.test(ld.gender) ? "female"
      : /male/i.test(ld.gender) ? "male" : null) : null;

    const ogImg = document.querySelector('meta[property="og:image"]');
    const photo = noData((ld && ld.image) || (ogImg && ogImg.getAttribute("content")) || null);

    return {
      id: urlId, name, nameOrig, gender, birthDate, deathDate, birthPlace,
      heightCm, zodiac, professions, genres, filmsTotal, careerStart, careerEnd,
      photo, sourceUrl: `/name/${urlId}/`,
      _ld: ld ? sanitizeLd(ld) : null,
      _rows: rows,
    };
  }

  function maybeSendPerson() {
    const m = location.pathname.match(/^\/name\/(\d+)\/?$/);
    if (!m) return;
    const personId = Number(m[1]);
    if (SENT_PERSON.has(personId)) return;
    const data = extractPerson();
    if (!data || !data.name) return;                 // ещё не отрисовалось/несинхронно
    commitPage(SENT_PERSON, personId,
      `⏳ персона #${personId}…`,
      `✓ персона #${personId}: ${data.name}`,
      `✗ персона #${personId}`,
      { type: "person", person: data },
      `✓ персона #${personId} — ${data.name}`);
  }

  // ---------- архив исходного HTML + оптимистичный коммит (реш. 28) ----------
  // Исходник страницы (page_html) и распарсенные данные пишутся ПАРАЛЛЕЛЬНО; «✓» показываем
  // только если успешны ОБА. Страницу помечаем обработанной лишь при полном успехе — иначе повтор
  // на следующем тике (все записи идемпотентны: upsert / DELETE+INSERT, html — upsert по url).

  // промисификация sendMessage: resp = {ok, result?} | {ok:false, error}
  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false });
      });
    });
  }

  // сохранение исходника текущей страницы — оптимистично, мемоизировано per-url за сессию.
  // Вызывается ИЗ парсера (страница уже признана готовой/синхронной), поэтому url = текущая страница.
  // Успех кэшируется; ошибка — нет (даём повтор). Возвращает Promise<boolean>.
  const _htmlSaved = new Map(); // url -> Promise<boolean>
  function ensureHtmlSaved() {
    const url = location.origin + location.pathname; // без query
    const cached = _htmlSaved.get(url);
    if (cached) return cached;
    const html = document.documentElement.outerHTML;
    const p = sendMsg({ type: "html", url, html }).then((resp) => {
      const ok = !!(resp && resp.ok);
      if (ok) dbg("исходник сохранён:", url, ((html.length / 1024) | 0) + "KB");
      else _htmlSaved.delete(url); // повторим в следующий раз
      return ok;
    });
    _htmlSaved.set(url, p);
    return p;
  }

  // оптимистичный коммит подстраницы: html-сейв и парс летят параллельно, ждём оба
  async function commitPage(sentSet, key, busy, okMsg, fail, msg, logLine) {
    sentSet.add(key);
    setBadge(busy, "#b8860b");
    const htmlP = ensureHtmlSaved();           // оптимистично, не ждём
    const resp = await sendMsg(msg);           // парс — параллельно с исходником
    const htmlOk = await htmlP;                // в конце дожидаемся исходника
    if (!(resp && resp.ok) || !htmlOk) {
      sentSet.delete(key);
      setBadge(fail, "#cf222e");
      dbg("commit fail", key, { dataOk: !!(resp && resp.ok), htmlOk, err: resp && resp.error });
      return;
    }
    setBadge(okMsg, "#1a7f37");
    if (logLine) console.log(`%c[kp] ${logLine}`, "color:green");
  }

  // ---------- консольный API ----------
  window.kp = {
    status: () => lastStatus || { note: "ещё не записан в этой сессии", currentId: consistentId() },
    links: () => {
      const all = [...filmsOnPage().keys()];
      return {
        all,
        known: all.filter((id) => KNOWN_DB.has(id)),
        unvisited: all.filter((id) => !KNOWN_DB.has(id)),
        persons: [...personsOnPage().keys()],
      };
    },
    go: (id) => { location.href = `/film/${id}/`; },
    person: () => extractPerson(),
    queue: () => refreshQueue(),
    refresh: () => { asked.clear(); markLinks(); sendDiscover(); },
  };

  // ---------- запуск ----------
  // ВАЖНО: НЕ используем MutationObserver — на React-странице Кинопоиска он вызывал шторм
  // (наши же правки DOM: подсветка ссылок/перерисовка панели → новые мутации → подвисание
  // навигации и перезагрузки). Достаточно редкого опроса.
  let _ticks = 0;
  function tick() {
    try {
      schedule();                                   // главная фильма: извлечение/отправка
      maybeSendCast();                              // /film/{id}/cast/: полный каст
      maybeSendDates();                             // /film/{id}/dates/: премьеры/релизы
      maybeSendBox();                               // /film/{id}/box/: сборы/затраты/уикенды
      maybeSendStudio();                            // /film/{id}/studio/: компании + тех.данные
      maybeSendOther();                             // /film/{id}/other/: связанные фильмы
      maybeSendKeywords();                          // /film/{id}/keywords/: ключевые слова
      maybeSendAwards();                             // /film/{id}/awards/: награды/номинации
      maybeSendPerson();                             // /name/{id}/: обогащение персоны
      if (_ticks % 2 === 0) { markLinks(); sendDiscover(); } // подсветка/очередь — реже (3 c)
    } catch (e) {
      dbg("tick error:", e && e.message);
    }
    _ticks++;
  }
  setInterval(tick, 1500);
  tick();
  refreshQueue();
})();
