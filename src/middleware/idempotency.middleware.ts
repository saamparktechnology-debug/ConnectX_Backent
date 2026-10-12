// src/middleware/idempotency.middleware.ts
import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database.js";
import { AppError } from "./error.middleware.js";

export function idempotency(scope: string) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const idemKey =
      (req.headers["x-idempotency-key"] as string) || req.body?.idempotencyKey;
    if (!idemKey) {
      return next(); // Endpoints that don't mandate an idempotency key proceed normally
    }

    try {
      // 1. Check if key has already been processed
      const [existing]: any = await pool.execute(
        `SELECT status_code, response_json, expires_at FROM idempotency_keys 
         WHERE scope = ? AND idem_key = ?`,
        [scope, idemKey],
      );

      if (existing.length > 0) {
        const record = existing[0];
        if (new Date(record.expires_at).getTime() > Date.now()) {
          // Replay cached response
          res.status(record.status_code).json(JSON.parse(record.response_json));
          return;
        }
      }

      // 2. Intercept response to store on successful execution
      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
          pool
            .execute(
              `INSERT INTO idempotency_keys (scope, idem_key, status_code, response_json, expires_at)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status_code = VALUES(status_code), response_json = VALUES(response_json)`,
              [scope, idemKey, res.statusCode, JSON.stringify(body), expiresAt],
            )
            .catch((err) =>
              console.error("Failed to persist idempotency key:", err),
            );
        }
        return originalJson(body);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
