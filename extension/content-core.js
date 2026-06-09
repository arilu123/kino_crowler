/*
 * Краулер Кинопоиска — ядро content-скрипта.
 * Состояние сессии, утилиты, разбор id/ld, парс русских дат, обмен с writer и коммит.
 * Часть content-скрипта (загрузка по порядку из manifest.json, общий isolated-world scope).
 */
const SEEN = new Set();        // фильмы, отправленные в этой сессии
const KNOWN_DB = new Set();    // фильмы, найденные в БД (для подсветки)
const asked = new Set();       // id, по которым уже спрашивали /known
let lastStatus = null;

const clean = (s) =>
  (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
// Текст ссылки «по частям»: на карточках листинга <a> оборачивает несколько вложенных
// <span> (номер, рус. название, оригинал, рейтинг). a.textContent склеивает их без пробелов
// ("…будущееBack to the Future8.5…"). Берём текст листовых узлов и склеиваем разделителем,
// чтобы части читались раздельно. Для простых ссылок (имя персоны) вернёт ровно одну часть.
const linkText = (a) => {
  const parts = [];
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {                    // текстовый узел
        const t = clean(c.textContent);
        if (t) parts.push(t);
      } else if (c.nodeType === 1) {             // элемент
        if (c.children.length) walk(c);          // есть вложенные — глубже
        else { const t = clean(c.textContent); if (t) parts.push(t); }  // лист
      }
    }
  };
  walk(a);
  return parts.join(" · ");
};
const idFromName = (u) => {
  const m = (u || "").match(/\/name\/(\d+)/);
  return m ? Number(m[1]) : null;
};
const idFromFilm = (u) => {
  const m = (u || "").match(/\/film\/(\d+)/);
  return m ? Number(m[1]) : null;
};
const idFromSeries = (u) => {
  const m = (u || "").match(/\/series\/(\d+)/);
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

// ---------- разбор русских дат (общий для /dates/ и /name/) ----------
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
