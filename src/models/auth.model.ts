// src/models/auth.model.ts
import { pool } from "../config/database.js";
import { PoolConnection } from "mysql2/promise";

export interface RefreshTokenRow {
  id: number;
  user_id: number;
  token_hash: string;
  family_id: string;
  device_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export class AuthModel {
  public static async insertOtp(
    phone: string,
    codeHash: string,
  ): Promise<void> {
    await pool.execute(
      `INSERT INTO otp_codes (phone, code_hash, expires_at) 
       VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 5 MINUTE))`,
      [phone, codeHash],
    );
  }

  public static async findValidOtp(
    phone: string,
  ): Promise<{ id: number; code_hash: string; attempts: number } | null> {
    const [rows]: any = await pool.execute(
      `SELECT id, code_hash, attempts 
       FROM otp_codes 
       WHERE phone = ? 
         AND consumed_at IS NULL 
         AND expires_at > CURRENT_TIMESTAMP(3)
       ORDER BY id DESC LIMIT 1`,
      [phone],
    );
    return rows[0] || null;
  }

  public static async incrementOtpAttempts(id: number): Promise<void> {
    await pool.execute(
      `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`,
      [id],
    );
  }

  public static async consumeOtp(id: number): Promise<void> {
    await pool.execute(
      `UPDATE otp_codes SET consumed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [id],
    );
  }

  public static async insertRefreshToken(
    conn: PoolConnection | typeof pool,
    data: {
      userId: number;
      tokenHash: string;
      familyId: string;
      deviceId: string;
      expiresAt: Date;
    },
  ): Promise<void> {
    await conn.execute(
      `INSERT INTO auth_refresh_tokens (user_id, token_hash, family_id, device_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        data.userId,
        data.tokenHash,
        data.familyId,
        data.deviceId,
        data.expiresAt,
      ],
    );
  }

  public static async lockRefreshTokenByHash(
    conn: PoolConnection,
    tokenHash: string,
  ): Promise<RefreshTokenRow | null> {
    const [rows]: any = await conn.execute(
      `SELECT * FROM auth_refresh_tokens WHERE token_hash = ? FOR UPDATE`,
      [tokenHash],
    );
    return rows[0] || null;
  }

  public static async revokeToken(
    conn: PoolConnection,
    id: number,
  ): Promise<void> {
    await conn.execute(
      `UPDATE auth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [id],
    );
  }

  public static async revokeFamily(
    conn: PoolConnection,
    familyId: string,
  ): Promise<void> {
    await conn.execute(
      `UPDATE auth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3) WHERE family_id = ?`,
      [familyId],
    );
  }
}
