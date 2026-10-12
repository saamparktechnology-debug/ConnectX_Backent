// src/config/database.ts
import mysql from "mysql2/promise";
import { env } from "./env.js";
import { logger } from "../utils/logger.util.js";

// src/config/database.ts
export const pool = mysql.createPool({
  host: env.DB_HOST,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  port: Number(env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "Z", // Enforces UTC handling across mysql2
  dateStrings: true,
});

export async function verifyDatabaseConnection(): Promise<void> {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    logger.info(
      "Database pool connected successfully to Hostinger MySQL 8 (UTC).",
    );
  } catch (error) {
    logger.error({ error }, "Failed to initialize database connection pool.");
    process.exit(1);
  }
}
