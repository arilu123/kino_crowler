/*
 * Краулер Кинопоиска — точка входа (грузится ПОСЛЕДНЕЙ).
 * Консольный API window.kp и опросный цикл tick(); вызывает функции остальных модулей.
 * Часть content-скрипта (загрузка по порядку из manifest.json, общий isolated-world scope).
 */
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
    scheduleSeries();                             // главная сериала: /series/{id}/
    maybeSendCast();                              // /film/{id}/cast/: полный каст
    maybeSendDates();                             // /film/{id}/dates/: премьеры/релизы
    maybeSendBox();                               // /film/{id}/box/: сборы/затраты/уикенды
    maybeSendStudio();                            // /film/{id}/studio/: компании + тех.данные
    maybeSendOther();                             // /film/{id}/other/: связанные фильмы
    maybeSendLike();                              // /film/{id}/like/: похожие фильмы
    maybeSendSeriesCast();                        // /series/{id}/cast/: полный каст сериала
    maybeSendEpisodes();                          // /series|film/{id}/episodes/: эпизоды сериала
    maybeSendKeywords();                          // /film/{id}/keywords/: ключевые слова
    maybeSendAwards();                             // /film/{id}/awards/: награды/номинации
    maybeSendPerson();                             // /name/{id}/: обогащение персоны
    if (_ticks % 2 === 0) { markLinks(); sendDiscover(); } // подсветка/очередь — реже (3 c)
    if (_ticks % 8 === 0) refreshQueue();           // надёжно обновляем очередь + список нерешённых атрибутов (~12 c)
  } catch (e) {
    dbg("tick error:", e && e.message);
  }
  _ticks++;
}
setInterval(tick, 1500);
tick();
refreshQueue();
