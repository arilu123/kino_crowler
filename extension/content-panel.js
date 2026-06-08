/*
 * Краулер Кинопоиска — панель.
 * Плавающая панель: очередь, переобход, бейдж статуса, список новых атрибутов.
 * Часть content-скрипта (загрузка по порядку из manifest.json, общий isolated-world scope).
 */
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
// ПОСТОЯННО показываем нерешённые обнаруженные атрибуты (status='new'), пока их не затриажат в БД.
// list — [{source, key, firstFilmId, firstValue}] из /queue.
function setPendingAttrs(list) {
  ensurePanel();
  if (!list || !list.length) { elNew.style.display = "none"; return; }
  let html = `<div style="font-weight:600;margin-bottom:3px">🆕 Новые атрибуты — нужен триаж (${list.length}):</div>`;
  for (const a of list) {
    const val = a.firstValue ? ` = «${esc(String(a.firstValue).slice(0, 40))}»` : "";
    const where = a.firstFilmId
      ? ` <a href="/film/${a.firstFilmId}/" style="color:#ffe;opacity:.85">#${a.firstFilmId}</a>`
      : "";
    html += `<div style="padding:1px 0">• <b>${esc(a.source)}:${esc(a.key)}</b>${esc(val)}${where}</div>`;
  }
  elNew.innerHTML = html;
  elNew.style.display = "block";
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
  setPendingAttrs((data && data.pendingAttrs) || []); // постоянный показ нерешённых атрибутов
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
