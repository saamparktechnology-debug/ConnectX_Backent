import mysql from "mysql2/promise";
import { env } from "./env.js";
import { logger } from "../utils/logger.util.js";

export const pool = mysql.createPool({
  host: env.DB_HOST,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  port: Number(env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "Z", // mysql2 serializes DATETIME as UTC
  dateStrings: true,
});

// Force every new pooled connection to run in UTC.
// In the promise API, `pool.on("connection", ...)` receives a promise-based
// connection, so we use `await conn.query(...)` not a callback.
pool.on("connection", async (conn) => {
  try {
    await conn.query("SET time_zone = '+00:00'");
  } catch (err) {
    logger.error({ err }, "Failed to set MySQL session timezone to UTC");
  }
});

export async function verifyDatabaseConnection(): Promise<void> {
  try {
    const connection = await pool.getConnection();
    await connection.ping();

    const [rows]: any = await connection.query(
      "SELECT @@session.time_zone AS tz, NOW(3) AS now_local, UTC_TIMESTAMP(3) AS now_utc",
    );
    logger.info(
      {
        sessionTz: rows[0].tz,
        nowLocal: rows[0].now_local,
        nowUtc: rows[0].now_utc,
      },
      "MySQL session timezone check",
    );

    connection.release();
    logger.info("Database pool connected successfully (UTC enforced).");
  } catch (error) {
    logger.error({ error }, "Failed to initialize database connection pool.");
    process.exit(1);
  }
}
