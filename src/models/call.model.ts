// src/models/call.model.ts
import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/database.js";

export interface CallSessionRow {
  id: number;
  uuid: string;
  room_id: string;
  caller_id: number;
  receiver_id: number;
  status: string;
  initiated_at: string;
  expires_at: string;
  accepted_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
}

export interface AdminCallHistoryRecord {
  id: number;
  session_id: number;
  session_uuid: string;
  room_id: string;
  caller_id: number;
  caller_name: string | null;
  caller_phone: string;
  receiver_id: number;
  companion_name: string | null;
  companion_phone: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  billed_minutes: number;
  rate_caller: string;
  rate_receiver: string;
  amount_deducted: string;
  amount_earned: string;
  platform_margin: string;
  end_reason: string | null;
  status: string;
}

export class CallModel {
  public static async insertSession(
    conn: PoolConnection,
    data: {
      uuid: string;
      roomId: string;
      callerId: number;
      receiverId: number;
      expiresAt: Date;
    },
  ): Promise<number> {
    const [result]: any = await conn.execute(
      `INSERT INTO call_sessions (uuid, room_id, caller_id, receiver_id, status, expires_at)
       VALUES (?, ?, ?, ?, 'initiated', ?)`,
      [data.uuid, data.roomId, data.callerId, data.receiverId, data.expiresAt],
    );
    return result.insertId;
  }

  public static async lockSessionByUuid(
    conn: PoolConnection,
    uuid: string,
  ): Promise<CallSessionRow | null> {
    const [rows]: any = await conn.execute(
      `SELECT * FROM call_sessions WHERE uuid = ? FOR UPDATE`,
      [uuid],
    );
    return rows[0] || null;
  }

  public static async acceptSession(
    receiverId: number,
    uuid: string,
  ): Promise<boolean> {
    const [result]: any = await pool.execute(
      `UPDATE call_sessions 
       SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP(3) 
       WHERE uuid = ? AND receiver_id = ? AND status IN ('initiated', 'ringing') AND expires_at > CURRENT_TIMESTAMP(3)`,
      [uuid, receiverId],
    );
    return result.affectedRows > 0;
  }

  public static async updateEnded(
    conn: PoolConnection,
    id: number,
    status: string,
    endedAt: Date,
    endReason: string,
  ): Promise<void> {
    await conn.execute(
      `UPDATE call_sessions SET status = ?, ended_at = ?, end_reason = ? WHERE id = ?`,
      [status, endedAt, endReason, id],
    );
  }

  public static async insertCallHistory(
    conn: PoolConnection,
    data: {
      uuid: string;
      sessionId: number;
      callerId: number;
      receiverId: number;
      startTime: Date;
      endTime: Date;
      durationSeconds: number;
      billedMinutes: number;
      rateCaller: string;
      rateReceiver: string;
      amountDeducted: string;
      amountEarned: string;
      platformMargin: string;
    },
  ): Promise<number> {
    const [result]: any = await conn.execute(
      `INSERT INTO calls_history 
       (uuid, session_id, caller_id, receiver_id, start_time, end_time, duration_seconds, 
        billed_minutes, rate_caller, rate_receiver, amount_deducted, amount_earned, platform_margin, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finalized')`,
      [
        data.uuid,
        data.sessionId,
        data.callerId,
        data.receiverId,
        data.startTime,
        data.endTime,
        data.durationSeconds,
        data.billedMinutes,
        data.rateCaller,
        data.rateReceiver,
        data.amountDeducted,
        data.amountEarned,
        data.platformMargin,
      ],
    );
    return result.insertId;
  }

  public static async findExpiredInitiated(
    limit: number = 50,
  ): Promise<CallSessionRow[]> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM call_sessions 
       WHERE status IN ('initiated', 'ringing') AND expires_at <= CURRENT_TIMESTAMP(3)
       LIMIT ?`,
      [limit],
    );
    return rows;
  }

  public static async findActiveOngoingSessions(): Promise<
    Array<{
      id: number;
      uuid: string;
      caller_id: number;
      receiver_id: number;
      accepted_at: string;
    }>
  > {
    const [rows]: any = await pool.execute(
      `SELECT id, uuid, caller_id, receiver_id, accepted_at
       FROM call_sessions WHERE status = 'accepted'`,
    );
    return rows;
  }

  public static async listAdminCalls(params: {
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    calls: AdminCallHistoryRecord[];
    total: number;
    activeCount: number;
  }> {
    const limit = params.limit || 20;
    const offset = params.offset || 0;

    const conditions: string[] = [];
    const queryParams: any[] = [];

    if (params.search && params.search.trim()) {
      conditions.push(
        "(cs.uuid LIKE ? OR cs.room_id LIKE ? OR u_c.phone LIKE ? OR u_r.phone LIKE ? OR u_c.nickname LIKE ? OR u_r.nickname LIKE ?)",
      );
      const term = `%${params.search.trim()}%`;
      queryParams.push(term, term, term, term, term, term);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows]: any = await pool.execute(
      `SELECT 
         ch.id,
         ch.session_id,
         cs.uuid AS session_uuid,
         cs.room_id,
         ch.caller_id,
         u_c.nickname AS caller_name,
         u_c.phone AS caller_phone,
         ch.receiver_id,
         u_r.nickname AS companion_name,
         u_r.phone AS companion_phone,
         ch.start_time,
         ch.end_time,
         ch.duration_seconds,
         ch.billed_minutes,
         ch.rate_caller,
         ch.rate_receiver,
         ch.amount_deducted,
         ch.amount_earned,
         ch.platform_margin,
         cs.end_reason,
         ch.status
       FROM calls_history ch
       INNER JOIN call_sessions cs ON ch.session_id = cs.id
       LEFT JOIN users u_c ON ch.caller_id = u_c.id
       LEFT JOIN users u_r ON ch.receiver_id = u_r.id
       ${whereClause}
       ORDER BY ch.start_time DESC
       LIMIT ? OFFSET ?`,
      [...queryParams, limit.toString(), offset.toString()],
    );

    const [countRows]: any = await pool.execute(
      `SELECT COUNT(*) as total 
       FROM calls_history ch
       INNER JOIN call_sessions cs ON ch.session_id = cs.id
       LEFT JOIN users u_c ON ch.caller_id = u_c.id
       LEFT JOIN users u_r ON ch.receiver_id = u_r.id
       ${whereClause}`,
      queryParams,
    );

    const [activeRows]: any = await pool.execute(
      `SELECT COUNT(*) as active_count FROM call_sessions WHERE status IN ('initiated', 'ringing', 'accepted')`,
    );

    return {
      calls: rows,
      total: countRows[0]?.total || 0,
      activeCount: activeRows[0]?.active_count || 0,
    };
  }
}
