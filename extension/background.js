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
    post("/discover", { films: msg.films, persons: msg.persons, pages: msg.pages }, sendResponse);
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
});
