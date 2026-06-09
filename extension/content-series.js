/*
 * Краулер Кинопоиска — главная страница СЕРИАЛА (/series/{id}/).
 * Формат страницы идентичен главной фильма (Next.js, encyclopedic-table, ld @type=TVSeries),
 * поэтому разбор переиспользует extractFromPage() из content-film.js. Отличия — только id/ld
 * (namespace /series/) и отдельная цель записи (таблицы series / series_credits, type:"series").
 * Часть content-скрипта (грузится после content-film.js — там определён extractFromPage).
 */
const SEEN_SERIES = new Set();   // ОТДЕЛЬНЫЙ от SEEN: id сериала и фильма могут совпадать численно

// ld+json типа TVSeries, соответствующий текущему адресу (устаревший на SPA не берём)
const currentSeriesLd = () => {
  const urlId = idFromSeries(location.pathname);
  if (!urlId) return null;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const o = JSON.parse(s.textContent);
      if (o && o["@type"] === "TVSeries" && idFromSeries(o.url) === urlId) return o;
    } catch (_) {}
  }
  return null;
};

// id сериала по ТЕЛУ/голове страницы. На главной сериала нет ссылки «/series/ID/cast/»
// (в отличие от фильма), поэтому якоримся за canonical/og:url (Next.js обновляет их на навигации),
// плюс любой подстраничный якорь /series/ID/<sub>, если он на странице есть.
function domSeriesId() {
  for (const a of document.querySelectorAll('a[href*="/series/"]')) {
    const m = (a.getAttribute("href") || "").match(/\/series\/(\d+)\/[a-z]/);
    if (m) return Number(m[1]);
  }
  const can = document.querySelector('link[rel="canonical"], meta[property="og:url"]');
  if (can) return idFromSeries(can.getAttribute("href") || can.getAttribute("content"));
  return null;
}

// готовы извлекать только когда тело/голова страницы соответствуют адресу
function consistentSeriesId() {
  const urlId = idFromSeries(location.pathname);
  return urlId && domSeriesId() === urlId ? urlId : null;
}

function extractSeries() {
  const id = consistentSeriesId();
  if (!id) return null;
  const movie = extractFromPage(id, currentSeriesLd());   // общий разбор (content-film.js)
  if (movie) movie.kind = "series";                       // пометка типа (в raw)
  return movie;
}

// ---------- отправка сериала ----------
async function sendSeries(movie) {
  setBadge(`⏳ запись сериала #${movie.id}…`, "#b8860b");
  const htmlP = ensureHtmlSaved();
  const resp = await sendMsg({ type: "series", movie });
  const htmlOk = await htmlP;
  const r = resp && resp.ok && resp.result;
  if (!r || !htmlOk) {
    SEEN_SERIES.delete(movie.id);   // повтор на следующем тике (записи идемпотентны)
    setBadge(`✗ ошибка записи сериала #${movie.id}`, "#cf222e");
    console.warn("[kp] ошибка записи сериала", movie.id, { dataOk: !!r, htmlOk, error: resp && resp.error });
    return;
  }
  lastStatus = { id: movie.id, title: movie.title, isNew: r.isNew, firstSeen: r.firstSeen, kind: "series" };
  if (r.isNew) setBadge(`✓ сериал #${movie.id} записан · ${movie.title}`, "#1a7f37");
  else {
    const d = r.firstSeen ? new Date(r.firstSeen).toLocaleDateString("ru-RU") : "";
    setBadge(`↻ сериал #${movie.id} обновлён · был ${d}`, "#0969da");
  }
  console.log(`%c[kp] ${r.isNew ? "✓ записан" : "↻ обновлён"} сериал #${movie.id} — ${movie.title}`, "color:green");
  if (r.newAttrs && r.newAttrs.length)
    console.warn("[kp] 🆕 впервые встречены атрибуты:", r.newAttrs.join(", "));
  refreshQueue();
}

let debounceSeries = null;
function scheduleSeries() {
  const path = location.pathname;
  if (!/^\/series\/\d+\/?$/.test(path)) return;          // только ГЛАВНАЯ сериала
  const urlId = idFromSeries(path);
  const id = consistentSeriesId();
  if (!id) {
    if (!SEEN_SERIES.has(urlId)) setBadge("⏳ загрузка сериала…", "#555");
    return;
  }
  if (SEEN_SERIES.has(id)) return;
  clearTimeout(debounceSeries);
  debounceSeries = setTimeout(() => {
    const id2 = consistentSeriesId();
    if (!id2 || id2 !== id || SEEN_SERIES.has(id2)) return;
    const movie = extractSeries();
    if (!movie || movie.id !== id2) return;
    SEEN_SERIES.add(id2);
    sendSeries(movie);
  }, 600);
}
