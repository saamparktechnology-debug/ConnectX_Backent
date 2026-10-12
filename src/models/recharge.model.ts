// src/models/recharge.model.ts
import { RowDataPacket } from "mysql2";
import { pool } from "../config/database.js";

export interface RechargeRecord extends RowDataPacket {
  id: number;
  uuid: string;
  user_id: number;
  user_phone?: string;
  user_nickname?: string;
  base_amount: string;
  tax_amount: string;
  total_amount: string;
  currency: string;
  status: "pending" | "success" | "failed" | "user_cancelled";
  pg_provider: string;
  pg_txn_id: string | null;
  pg_status: string | null;
  pg_hash: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export class RechargeModel {
  public static async listOrders(params: {
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ orders: RechargeRecord[]; total: number }> {
    const limit = params.limit || 20;
    const offset = params.offset || 0;

    const conditions: string[] = [];
    const queryParams: any[] = [];

    if (params.status && params.status !== "all") {
      conditions.push("r.status = ?");
      queryParams.push(params.status);
    }

    if (params.search && params.search.trim()) {
      conditions.push(
        "(r.uuid LIKE ? OR r.pg_txn_id LIKE ? OR u.phone LIKE ? OR u.nickname LIKE ?)",
      );
      const term = `%${params.search.trim()}%`;
      queryParams.push(term, term, term, term);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows]: any = await pool.execute(
      `SELECT 
         r.*,
         CONCAT(SUBSTRING(u.phone, 1, 3), '****', SUBSTRING(u.phone, -4)) AS user_phone,
         u.nickname AS user_nickname
       FROM recharges r
       LEFT JOIN users u ON r.user_id = u.id
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [...queryParams, limit.toString(), offset.toString()],
    );

    const [countRows]: any = await pool.execute(
      `SELECT COUNT(*) as total 
       FROM recharges r
       LEFT JOIN users u ON r.user_id = u.id
       ${whereClause}`,
      queryParams,
    );

    return {
      orders: rows,
      total: countRows[0]?.total || 0,
    };
  }

  public static async findById(
    orderId: number,
  ): Promise<RechargeRecord | null> {
    const [rows]: any = await pool.execute(
      `SELECT 
         r.*,
         CONCAT(SUBSTRING(u.phone, 1, 3), '****', SUBSTRING(u.phone, -4)) AS user_phone,
         u.nickname AS user_nickname
       FROM recharges r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.id = ? LIMIT 1`,
      [orderId],
    );
    return rows[0] || null;
  }
}
