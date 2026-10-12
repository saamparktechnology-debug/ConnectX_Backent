// src/models/wallet.model.ts
import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/database.js";

export interface WalletTransactionRow {
  id: number;
  uuid: string;
  user_id: number;
  type: string;
  direction: "credit" | "debit";
  amount: string;
  balance_before: string;
  balance_after: string;
  reference_type: string;
  reference_id: number;
  reference_uuid: string | null;
  idempotency_key: string | null;
  metadata: any;
  created_at: string;
}

export class WalletModel {
  public static async insertLedger(
    conn: PoolConnection,
    data: {
      uuid: string;
      userId: number;
      type: string;
      direction: "credit" | "debit";
      amount: string;
      balanceBefore: string;
      balanceAfter: string;
      referenceType: string;
      referenceId: number;
      referenceUuid?: string | null;
      idempotencyKey?: string | null;
      metadata?: Record<string, any> | null;
    },
  ): Promise<number> {
    const [result]: any = await conn.execute(
      `INSERT INTO wallet_transactions 
       (uuid, user_id, type, direction, amount, balance_before, balance_after,
        reference_type, reference_id, reference_uuid, idempotency_key, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.uuid,
        data.userId,
        data.type,
        data.direction,
        data.amount,
        data.balanceBefore,
        data.balanceAfter,
        data.referenceType,
        data.referenceId,
        data.referenceUuid ?? null,
        data.idempotencyKey ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
      ],
    );
    return result.insertId;
  }

  public static async getUserTransactions(
    userId: number,
    limit: number = 20,
    offset: number = 0,
  ): Promise<WalletTransactionRow[]> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM wallet_transactions 
       WHERE user_id = ? 
       ORDER BY id DESC 
       LIMIT ? OFFSET ?`,
      [userId, limit, offset],
    );
    return rows;
  }
}
