// src/models/rating.model.ts
import { pool } from "../config/database.js";

export interface RatingRow {
  id: number;
  call_id: number;
  rater_id: number;
  ratee_id: number;
  rating: number;
  review: string | null;
  is_flagged: boolean;
  flagged_reason: string | null;
  created_at: string;
}

export class RatingModel {
  public static async create(data: {
    callId: number;
    raterId: number;
    rateeId: number;
    rating: number;
    review?: string | null;
    isFlagged: boolean;
    flaggedReason?: string | null;
  }): Promise<number> {
    const [result]: any = await pool.execute(
      `INSERT INTO ratings_reviews 
       (call_id, rater_id, ratee_id, rating, review, is_flagged, flagged_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.callId,
        data.raterId,
        data.rateeId,
        data.rating,
        data.review ?? null,
        data.isFlagged,
        data.flaggedReason ?? null,
      ],
    );
    return result.insertId;
  }

  public static async hasRated(
    callId: number,
    raterId: number,
  ): Promise<boolean> {
    const [rows]: any = await pool.execute(
      `SELECT id FROM ratings_reviews WHERE call_id = ? AND rater_id = ?`,
      [callId, raterId],
    );
    return rows.length > 0;
  }

  public static async getPendingRatingForCaller(
    callerId: number,
  ): Promise<{ callId: number; companionName: string } | null> {
    const [rows]: any = await pool.execute(
      `SELECT ch.id AS call_id, u.nickname AS companion_name
       FROM calls_history ch
       JOIN users u ON ch.receiver_id = u.id
       LEFT JOIN ratings_reviews rr ON ch.id = rr.call_id AND rr.rater_id = ch.caller_id
       WHERE ch.caller_id = ? AND rr.id IS NULL
       ORDER BY ch.id DESC LIMIT 1`,
      [callerId],
    );
    if (!rows.length) return null;
    return { callId: rows[0].call_id, companionName: rows[0].companion_name };
  }

  public static async getFlaggedReviews(
    limit: number = 20,
    offset: number = 0,
  ): Promise<RatingRow[]> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM ratings_reviews WHERE is_flagged = TRUE ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows;
  }
}
