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
      genres: (rowText("genres") || "").split(",").map(clean).filter(Boolean),
      countries: (rowText("countries") || "").split(",").map(clean).filter(Boolean),
      duration: (ld ? num(ld.timeRequired) : null) || parseMinutes(rowText("duration")),
      ageRestriction: rowText("ageRestriction"),
      ratingMPAA: rowText("ratingMPAA") || (ld ? clean(ld.contentRating) : null),
      rating: ratingValue != null || ratingCount != null ? { value: ratingValue, count: ratingCount } : null,
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

  // ---------- панель: очередь (сверху) + статус (снизу) ----------
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
  function renderQueue(films) {
    ensurePanel();
    if (!films || !films.length) {
      elQueue.innerHTML = '<div style="opacity:.6">очередь пуста</div>';
      return;
    }
    let html = `<div style="opacity:.7;margin-bottom:4px">Очередь — новые фильмы (${films.length}):</div>`;
    for (const f of films) {
      const t = (f.title || "(без названия)").replace(/[<>&]/g, (c) =>
        ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      html += `<a href="/film/${f.id}/" style="display:block;color:#7cc4ff;text-decoration:none;padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">#${f.id} — ${t}</a>`;
    }
    elQueue.innerHTML = html;
  }
  function refreshQueue() {
    chrome.runtime.sendMessage({ type: "queue" }, (resp) => {
      if (resp && resp.ok && resp.result) renderQueue(resp.result.films);
    });
  }

  // ---------- отправка фильма ----------
  function send(movie) {
    setNewAttrs([]); // сбросить плашку предыдущего фильма
    setBadge(`⏳ запись #${movie.id}…`, "#b8860b");
    chrome.runtime.sendMessage({ type: "movie", movie }, (resp) => {
      if (chrome.runtime.lastError) {
        SEEN.delete(movie.id);
        setBadge(`✗ нет связи с расширением #${movie.id}`, "#cf222e");
        dbg("sendMessage lastError:", chrome.runtime.lastError.message);
        return;
      }
      dbg("ответ по #" + movie.id + ":", resp);
      const r = resp && resp.ok && resp.result;
      if (r) {
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
        refreshQueue(); // фильм ушёл из очереди — обновим список
      } else {
        SEEN.delete(movie.id);
        setBadge(`✗ ошибка записи #${movie.id}`, "#cf222e");
        console.warn("[kp] ошибка записи", movie.id, resp && resp.error);
      }
    });
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
    SENT_CAST.add(filmId);
    setBadge(`⏳ каст #${filmId}…`, "#b8860b");
    chrome.runtime.sendMessage({ type: "cast", filmId, credits: data.credits }, (resp) => {
      if (chrome.runtime.lastError || !(resp && resp.ok)) {
        SENT_CAST.delete(filmId);
        setBadge(`✗ каст #${filmId}`, "#cf222e");
        dbg("cast error", filmId, chrome.runtime.lastError || (resp && resp.error));
        return;
      }
      setBadge(`✓ каст #${filmId}: ${data.credits.length} чел.`, "#1a7f37");
      console.log(`%c[kp] ✓ каст #${filmId} — ${data.credits.length} участников`, "color:green");
    });
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
    SENT_DATES.add(filmId);
    setBadge(`⏳ даты #${filmId}…`, "#b8860b");
    chrome.runtime.sendMessage({ type: "dates", filmId, dates: data.dates }, (resp) => {
      if (chrome.runtime.lastError || !(resp && resp.ok)) {
        SENT_DATES.delete(filmId);
        setBadge(`✗ даты #${filmId}`, "#cf222e");
        return;
      }
      setBadge(`✓ даты #${filmId}: ${data.dates.length} зап.`, "#1a7f37");
      console.log(`%c[kp] ✓ даты #${filmId} — ${data.dates.length} записей`, "color:green");
    });
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
