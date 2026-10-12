// src/models/verification.model.ts
import { pool } from "../config/database.js";
import { PoolConnection } from "mysql2/promise";

export interface VerificationSubmissionRow {
  id: number;
  uuid: string;
  user_id: number;
  voice_url: string;
  voice_duration_sec: number;
  voice_mime: string;
  voice_size_bytes: number;
  status: "pending" | "approved" | "rejected";
  reviewed_by: number | null;
  reviewed_at: string | null;
  rejection_reason_code: string | null;
  rejection_reason_note: string | null;
  created_at: string;
}

export class VerificationModel {
  public static async create(data: {
    uuid: string;
    userId: number;
    voiceUrl: string;
    durationSec: number;
    mime: string;
    sizeBytes: number;
  }): Promise<number> {
    const [result]: any = await pool.execute(
      `INSERT INTO verification_submissions 
       (uuid, user_id, voice_url, voice_duration_sec, voice_mime, voice_size_bytes, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [
        data.uuid,
        data.userId,
        data.voiceUrl,
        data.durationSec,
        data.mime,
        data.sizeBytes,
      ],
    );
    return result.insertId;
  }

  public static async lockById(
    conn: PoolConnection,
    id: number,
  ): Promise<VerificationSubmissionRow | null> {
    const [rows]: any = await conn.execute(
      `SELECT * FROM verification_submissions WHERE id = ? FOR UPDATE`,
      [id],
    );
    return rows[0] || null;
  }

  public static async review(
    conn: PoolConnection,
    id: number,
    status: "approved" | "rejected",
    adminId: number,
    reasonCode?: string | null,
    reasonNote?: string | null,
  ): Promise<void> {
    await conn.execute(
      `UPDATE verification_submissions 
       SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3),
           rejection_reason_code = ?, rejection_reason_note = ?
       WHERE id = ?`,
      [status, adminId, reasonCode ?? null, reasonNote ?? null, id],
    );
  }

  public static async setUserVerificationStatus(
    conn: PoolConnection,
    userId: number,
    status: "pending" | "approved" | "rejected",
  ): Promise<void> {
    await conn.execute(
      `UPDATE users SET verification_status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [status, userId],
    );
  }

  public static async getPending(
    limit: number = 20,
    offset: number = 0,
  ): Promise<VerificationSubmissionRow[]> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM verification_submissions WHERE status = 'pending' ORDER BY created_at ASC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows;
  }
}
