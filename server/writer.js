/*
 * Локальный писатель краулера → Postgres. Node >=18.
 * Запуск:  node server/writer.js        (из корня проекта)
 * Зависимости: pg (npm i, уже в server/package.json).
 *
 * Принимает POST /movie с JSON фильма (схема — extractor.js / movie-info-list.md).
 * Делает в одной транзакции:
 *   - upsert в films (ON CONFLICT id → обновление, updated_at=now()).
 *   - upsert каждой персоны в persons (НЕ трогает флаг enriched).
 *   - пересборку film_credits (DELETE по film_id → INSERT актуального состава).
 *
 * БД — единственный источник правды. Очередь «что добрать»:
 *   persons WHERE enriched=false   /   films WHERE full_cast_fetched=false.
 */
const http = require("http");
const {
  saveMovie, saveCast, saveDates, saveBox, saveStudio,
  saveOther, saveLike, saveKeywords, saveAwards, savePerson, saveHtml,
  saveSeries, saveSeriesCast, saveEpisodes,
} = require("./saves");
const { knownFilmIds, discoverLinks, queueFilms } = require("./queue");

const PORT = process.env.PORT || 8787;

// живучесть процесса: не падать молча на разовых ошибках
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.method === "POST" && req.url === "/movie") {
    try {
      const result = await saveMovie(JSON.parse(await readBody(req)));
      const tag = result.isNew ? "новый" : "обновлён";
      console.log(`✓ ${result.id} ${result.title} (${result.persons} персон, ${tag})`);
      if (result.newAttrs && result.newAttrs.length)
        console.log(`  🆕 новые атрибуты: ${result.newAttrs.join(", ")}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/cast") {
    try {
      const result = await saveCast(JSON.parse(await readBody(req)));
      console.log(`✓ каст ${result.filmId} (${result.credits} чел.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ cast", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/dates") {
    try {
      const result = await saveDates(JSON.parse(await readBody(req)));
      console.log(`✓ даты ${result.filmId} (${result.dates} зап.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ dates", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/box") {
    try {
      const result = await saveBox(JSON.parse(await readBody(req)));
      console.log(`✓ сборы ${result.filmId} (${result.tab}, ${result.rows} стр.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ box", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/studio") {
    try {
      const result = await saveStudio(JSON.parse(await readBody(req)));
      console.log(`✓ студии ${result.filmId} (${result.studios} комп., ${result.tech} тех.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ studio", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/other") {
    try {
      const result = await saveOther(JSON.parse(await readBody(req)));
      console.log(`✓ связи ${result.filmId} (${result.relations} фильмов)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ other", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/series") {
    try {
      const result = await saveSeries(JSON.parse(await readBody(req)));
      const tag = result.isNew ? "новый" : "обновлён";
      console.log(`✓ сериал ${result.id} ${result.title} (${result.persons} персон, ${tag})`);
      if (result.newAttrs && result.newAttrs.length)
        console.log(`  🆕 новые атрибуты: ${result.newAttrs.join(", ")}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ series", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/series-cast") {
    try {
      const result = await saveSeriesCast(JSON.parse(await readBody(req)));
      console.log(`✓ каст сериала ${result.seriesId} (${result.credits} чел.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ series-cast", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/episodes") {
    try {
      const result = await saveEpisodes(JSON.parse(await readBody(req)));
      console.log(`✓ эпизоды ${result.seriesId} (${result.episodes} шт.)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ episodes", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/like") {
    try {
      const result = await saveLike(JSON.parse(await readBody(req)));
      console.log(`✓ похожие ${result.filmId} (${result.similar} фильмов)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ like", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/keywords") {
    try {
      const result = await saveKeywords(JSON.parse(await readBody(req)));
      console.log(`✓ ключ.слова ${result.filmId} (${result.keywords})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ keywords", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/awards") {
    try {
      const result = await saveAwards(JSON.parse(await readBody(req)));
      console.log(`✓ награды ${result.filmId} (${result.awards} строк)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ awards", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/html") {
    try {
      const result = await saveHtml(JSON.parse(await readBody(req)));
      console.log(`✓ исходник ${result.url} (${(result.bytes / 1024) | 0} KB)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ html", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/person") {
    try {
      const result = await savePerson(JSON.parse(await readBody(req)));
      console.log(`✓ персона ${result.id} (${result.name || "?"}${result.filmography ? `, фильмография: ${result.filmography}` : ""})`);
      if (result.newAttrs && result.newAttrs.length)
        console.log(`  🆕 новые атрибуты персоны: ${result.newAttrs.join(", ")}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("✗ person", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/known") {
    try {
      const { ids } = JSON.parse(await readBody(req));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ known: await knownFilmIds(ids) }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/discover") {
    try {
      const payload = JSON.parse(await readBody(req));
      const result = await discoverLinks(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/queue") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await queueFilms()));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () =>
  console.log(`kp-crawler writer → Postgres, слушает http://localhost:${PORT}`)
);
