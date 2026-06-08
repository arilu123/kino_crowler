/* Общий пул соединений с Postgres (БД kinopoisk). */
const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://mac@localhost:5432/kinopoisk",
});

// живучесть: не падать молча на разовых ошибках пула
pool.on("error", (e) => console.error("pg pool error:", e.message));

module.exports = { pool };
