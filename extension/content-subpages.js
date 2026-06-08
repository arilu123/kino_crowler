/*
 * Краулер Кинопоиска — подстраницы фильма.
 * Экстракторы /cast/ /dates/ /box/ /studio/ /other/ /keywords/ /awards/ + их отправка.
 * Часть content-скрипта (загрузка по порядку из manifest.json, общий isolated-world scope).
 */
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
