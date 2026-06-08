/*
 * Краулер Кинопоиска — персона.
 * Экстрактор страницы /name/{id}/ (формат Next.js) + отправка обогащения.
 * Часть content-скрипта (загрузка по порядку из manifest.json, общий isolated-world scope).
 */
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

// меню «фильмография по профессиям»: кнопки role/subrole + счётчик фильмов.
// Якорь — маркер #person-filmography-block (за ним <nav> с кнопками); иерархию кодирует
// сама подпись: «Актер» → role=Актер, subrole=null; «Актер: играет самого себя» → role=Актер,
// subrole=«играет самого себя». Не завязываемся на хеши классов: ловим кнопки с подписью «N фильм…».
function extractFilmography() {
  const marker = document.getElementById("person-filmography-block");
  const root = marker ? marker.parentElement : document;
  if (!root) return [];
  const out = [];
  let ord = 0;
  const seen = new Set();
  for (const btn of root.querySelectorAll("button")) {
    const spans = btn.querySelectorAll(":scope > span");
    if (spans.length < 2) continue;
    const label = clean(spans[0].textContent);
    const sub = clean(spans[1].textContent);
    const cm = sub.match(/(\d[\d\s]*)\s*фильм/i);     // «75 фильмов», «1 фильм», «1 234 фильма»
    if (!label || !cm) continue;                      // не пункт фильмографии
    if (seen.has(label)) continue;
    seen.add(label);
    const parts = label.split(/:\s*/);
    out.push({
      ord: ord++,
      role: clean(parts[0]),
      subrole: parts.length > 1 ? clean(parts.slice(1).join(": ")) || null : null,
      count: Number(cm[1].replace(/\s/g, "")),
      label,
    });
  }
  return out;
}

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
    filmography: extractFilmography(),   // роль/подроль → число фильмов (отдельная таблица)
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
