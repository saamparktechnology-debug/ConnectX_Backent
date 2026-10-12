// src/models/withdrawal.model.ts
import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/database.js";

export interface WithdrawalRow {
  id: number;
  uuid: string;
  user_id: number;
  requested_amount: string;
  tax_amount: string;
  net_amount: string;
  payout_method: string;
  payout_upi_id: string;
  status: "pending" | "paid" | "rejected" | "failed";
  processed_by: number | null;
  processed_at: string | null;
  admin_note: string | null;
  idempotency_key: string;
  created_at: string;
}

export class WithdrawalModel {
  public static async create(
    conn: PoolConnection,
    data: {
      uuid: string;
      userId: number;
      requestedAmount: string;
      taxAmount: string;
      netAmount: string;
      payoutUpiId: string;
      idempotencyKey: string;
    },
  ): Promise<number> {
    const [result]: any = await conn.execute(
      `INSERT INTO withdrawals 
       (uuid, user_id, requested_amount, tax_amount, net_amount, payout_method, payout_upi_id, status, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'upi', ?, 'pending', ?)`,
      [
        data.uuid,
        data.userId,
        data.requestedAmount,
        data.taxAmount,
        data.netAmount,
        data.payoutUpiId,
        data.idempotencyKey,
      ],
    );
    return result.insertId;
  }

  public static async lockById(
    conn: PoolConnection,
    id: number,
  ): Promise<WithdrawalRow | null> {
    const [rows]: any = await conn.execute(
      `SELECT * FROM withdrawals WHERE id = ? FOR UPDATE`,
      [id],
    );
    return rows[0] || null;
  }

  public static async updateSettled(
    conn: PoolConnection,
    id: number,
    status: "paid" | "rejected" | "failed",
    adminId: number,
    adminNote?: string | null,
  ): Promise<void> {
    await conn.execute(
      `UPDATE withdrawals 
       SET status = ?, processed_by = ?, processed_at = CURRENT_TIMESTAMP(3), admin_note = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [status, adminId, adminNote ?? null, id],
    );
  }

  public static async getPending(
    limit: number = 50,
    offset: number = 0,
  ): Promise<WithdrawalRow[]> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY created_at ASC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows;
  }
}
