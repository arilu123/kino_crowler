/*
 * Service worker: мост между content-script и локальным писателем.
 * Сетевые запросы делаем здесь (host_permissions на localhost обходят CORS/CSP).
 */
const BASE = "http://localhost:8787";

function post(path, payload, sendResponse) {
  fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json())
    .then((j) => sendResponse({ ok: true, result: j }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "movie") {
    post("/movie", msg.movie, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "known") {
    post("/known", { ids: msg.ids }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "discover") {
    post("/discover", { films: msg.films, persons: msg.persons, series: msg.series, companies: msg.companies, pages: msg.pages, sections: msg.sections }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "queue") {
    post("/queue", {}, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "cast") {
    post("/cast", { filmId: msg.filmId, credits: msg.credits }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "dates") {
    post("/dates", { filmId: msg.filmId, dates: msg.dates }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "box") {
    post("/box", { filmId: msg.filmId, tab: msg.tab, rows: msg.rows }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "studio") {
    post("/studio", { filmId: msg.filmId, tech: msg.tech, studios: msg.studios }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "other") {
    post("/other", { filmId: msg.filmId, relations: msg.relations }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "like") {
    post("/like", { filmId: msg.filmId, similar: msg.similar }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "keywords") {
    post("/keywords", { filmId: msg.filmId, keywords: msg.keywords }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "awards") {
    post("/awards", { filmId: msg.filmId, awards: msg.awards }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "person") {
    post("/person", { person: msg.person }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "series") {
    post("/series", msg.movie, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "seriesCast") {
    post("/series-cast", { seriesId: msg.seriesId, credits: msg.credits }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "episodes") {
    post("/episodes", { seriesId: msg.seriesId, episodes: msg.episodes }, sendResponse);
    return true; // async
  }
  if (msg && msg.type === "html") {
    post("/html", { url: msg.url, html: msg.html }, sendResponse);
    return true; // async
  }
});
