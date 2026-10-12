import { pool } from "../../config/database.js";
import { v4 as uuidv4 } from "uuid";
import { ZegoCloudService } from "./zegocloud.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { UserModel } from "../../models/user.model.js";
import { CallModel } from "../../models/call.model.js";
import { AppError } from "../../middleware/error.middleware.js";
import { emitToUser } from "../../socket/socket.server.js";

export class CallsService {
  /**
   * Server-authoritative Call Gate:
   * 1. Acquires pessimistic row-locks on caller and companion inside a dedicated transaction.
   * 2. Enforces caller balance sufficiency (min 1 minute at ₹3.00/min).
   * 3. Validates that the companion is female, active, approved, and explicitly toggled online.
   * 4. Relies on the database constraint `uq_active_receiver_lock` for anti-collision.
   * 5. Sets 60-second ringing timeout window.
   * 6. Emits `call:incoming` to the receiver via Socket.IO AFTER commit.
   */
  public static async initiateCall(callerId: number, receiverUuid: string) {
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // 1. Lock caller row & validate balance
      const caller = await UserModel.lockById(conn, callerId);
      if (!caller) {
        throw new AppError(
          404,
          "CALLER_NOT_FOUND",
          "Caller account could not be found.",
        );
      }
      if (caller.account_state !== "active") {
        throw new AppError(
          403,
          "CALLER_INACTIVE",
          `Your account is ${caller.account_state}.`,
        );
      }

      const callerBalance = parseFloat(caller.wallet_balance);
      if (callerBalance < 3.0) {
        throw new AppError(
          400,
          "INSUFFICIENT_BALANCE",
          "A minimum wallet balance of ₹3.00 (1 full minute) is required to place a call.",
        );
      }

      // 2. Lock receiver row & validate companion availability
      const receiver = await UserModel.lockByUuid(conn, receiverUuid);
      if (!receiver) {
        throw new AppError(
          404,
          "RECEIVER_NOT_FOUND",
          "Companion profile not found.",
        );
      }

      if (receiver.gender !== "female") {
        throw new AppError(
          400,
          "INVALID_RECIPIENT",
          "Calls can only be placed to female companion profiles.",
        );
      }

      if (receiver.id === caller.id) {
        throw new AppError(
          400,
          "SELF_CALL_PROHIBITED",
          "You cannot call your own account.",
        );
      }

      if (!receiver.is_online) {
        throw new AppError(
          400,
          "RECEIVER_OFFLINE",
          "Companion is currently offline and not accepting calls.",
        );
      }

      if (receiver.verification_status !== "approved") {
        throw new AppError(
          403,
          "RECEIVER_UNVERIFIED",
          "Companion profile is not verified to receive calls.",
        );
      }

      if (receiver.account_state !== "active") {
        throw new AppError(
          403,
          "RECEIVER_INACTIVE",
          "Companion is currently unavailable.",
        );
      }

      // 3. Provision Call Session & ZEGOCLOUD Room
      const sessionUuid = uuidv4();
      const roomId = `room_${sessionUuid.replace(/-/g, "")}`;
      const expiresAt = new Date(Date.now() + 60 * 1000);

      await CallModel.insertSession(conn, {
        uuid: sessionUuid,
        roomId,
        callerId: caller.id,
        receiverId: receiver.id,
        expiresAt,
      });

      // 4. Generate scoped privilege tokens for both peers
      const callerToken = ZegoCloudService.generateRoomToken(
        String(caller.id),
        roomId,
      );

      await conn.commit();

      // 5. Emit `call:incoming` to receiver AFTER commit (durable)
      emitToUser(receiver.id, "call:incoming", {
        sessionUuid,
        roomId,
        callerId: caller.id,
        callerNickname: caller.nickname,
        callerAvatar: caller.avatar_url,
        callerLanguage: caller.primary_language,
        secondsUntilExpiry: 60,
      });

      return {
        sessionUuid,
        roomId,
        callerToken,
        receiverUuid: receiver.uuid,
        receiverNickname: receiver.nickname,
        timeoutSeconds: 60,
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  public static async initiateRandomCall(callerId: number) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const caller = await UserModel.lockById(conn, callerId);
      if (!caller)
        throw new AppError(
          404,
          "CALLER_NOT_FOUND",
          "Caller account not found.",
        );
      if (caller.account_state !== "active") {
        throw new AppError(
          403,
          "CALLER_INACTIVE",
          `Your account is ${caller.account_state}.`,
        );
      }
      if (caller.gender !== "male") {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Only male callers can start random calls.",
        );
      }
      if (parseFloat(caller.wallet_balance) < 3.0) {
        throw new AppError(
          400,
          "INSUFFICIENT_BALANCE",
          "Minimum ₹3.00 required.",
        );
      }

      // Pick up to 3 random online, approved, active females not in an active session
      const [rows]: any = await conn.execute(
        `SELECT u.id, u.uuid, u.nickname, u.avatar_url
         FROM users u
        WHERE u.gender = 'female'
          AND u.is_online = TRUE
          AND u.verification_status = 'approved'
          AND u.account_state = 'active'
          AND u.deleted_at IS NULL
          AND u.id <> ?
          AND NOT EXISTS (
            SELECT 1 FROM call_sessions cs
             WHERE cs.receiver_id = u.id
               AND cs.status IN ('initiated','ringing','accepted')
          )
        ORDER BY RAND()
        LIMIT 3
        FOR UPDATE`,
        [callerId],
      );

      if (!rows.length) {
        throw new AppError(
          404,
          "NO_FEMALES_AVAILABLE",
          "No companions online right now.",
        );
      }

      const sessionUuid = uuidv4();
      const roomId = `room_${sessionUuid.replace(/-/g, "")}`;
      const expiresAt = new Date(Date.now() + 60_000);

      const [insResult]: any = await conn.execute(
        `INSERT INTO call_sessions
         (uuid, room_id, caller_id, receiver_id, status, is_random, expires_at)
       VALUES (?, ?, ?, NULL, 'ringing', 1, ?)`,
        [sessionUuid, roomId, callerId, expiresAt],
      );
      const sessionId = insResult.insertId;

      for (const r of rows) {
        await conn.execute(
          `INSERT INTO call_broadcast_targets (session_id, receiver_id)
         VALUES (?, ?)`,
          [sessionId, r.id],
        );
      }

      const callerToken = ZegoCloudService.generateRoomToken(
        String(caller.id),
        roomId,
      );

      await conn.commit();

      // Emit to all targets
      for (const r of rows) {
        emitToUser(r.id, "call:random-incoming", {
          sessionUuid,
          roomId,
          callerId: caller.id,
          callerNickname: caller.nickname,
          callerAvatar: caller.avatar_url,
          secondsUntilExpiry: 60,
        });
      }

      return {
        sessionUuid,
        roomId,
        callerToken,
        timeoutSeconds: 60,
        targetCount: rows.length,
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Companion accepts a ringing call.
   * Only the assigned receiver may accept. Only valid while status ∈ (initiated, ringing).
   * Emits `call:accepted` to BOTH peers after commit.
   */
  public static async acceptCall(receiverId: number, sessionUuid: string) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const session = await CallModel.lockSessionByUuid(conn, sessionUuid);
      if (!session)
        throw new AppError(404, "SESSION_NOT_FOUND", "Call session not found.");

      const isRandom = (session as any).is_random === 1;

      if (isRandom) {
        // Must be one of the broadcast targets
        const [trows]: any = await conn.execute(
          `SELECT id FROM call_broadcast_targets
          WHERE session_id = ? AND receiver_id = ?
          LIMIT 1`,
          [session.id, receiverId],
        );
        if (!trows.length) {
          throw new AppError(
            403,
            "FORBIDDEN",
            "Not a target of this broadcast.",
          );
        }
      } else if (session.receiver_id !== receiverId) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "You are not the assigned receiver.",
        );
      }

      if (session.status === "accepted") {
        await conn.commit();
        return { status: "accepted" };
      }
      if (!["initiated", "ringing"].includes(session.status)) {
        throw new AppError(
          400,
          "CALL_EXPIRED_OR_INVALID",
          `Call is ${session.status}.`,
        );
      }

      const now = Date.now();
      if (new Date(session.expires_at).getTime() <= now) {
        throw new AppError(
          400,
          "CALL_EXPIRED_OR_INVALID",
          "Call request expired.",
        );
      }

      await conn.execute(
        `UPDATE call_sessions
          SET status = 'accepted', accepted_at = NOW(3), receiver_id = ?
        WHERE id = ?`,
        [receiverId, session.id],
      );

      if (isRandom) {
        await conn.execute(
          `UPDATE call_broadcast_targets
            SET responded_at = NOW(3), accepted = (receiver_id = ?)
          WHERE session_id = ? AND responded_at IS NULL`,
          [receiverId, session.id],
        );
      }

      await conn.commit();

      emitToUser(session.caller_id, "call:accepted", { sessionUuid });
      emitToUser(receiverId, "call:accepted", { sessionUuid });

      if (isRandom) {
        // Notify all losing targets
        const [losers]: any = await conn.execute(
          `SELECT receiver_id FROM call_broadcast_targets
          WHERE session_id = ? AND receiver_id <> ?`,
          [session.id, receiverId],
        );
        for (const l of losers) {
          emitToUser(l.receiver_id, "call:random-taken", { sessionUuid });
        }
      }

      return { status: "accepted" };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Companion rejects a ringing call.
   * Only the assigned receiver may reject. Only valid while status ∈ (initiated, ringing).
   * Emits `call:rejected` to the caller after commit.
   */
  public static async rejectCall(receiverId: number, sessionUuid: string) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const session = await CallModel.lockSessionByUuid(conn, sessionUuid);
      if (!session)
        throw new AppError(404, "SESSION_NOT_FOUND", "Call session not found.");

      const isRandom = (session as any).is_random === 1;

      if (isRandom) {
        const [trows]: any = await conn.execute(
          `SELECT id FROM call_broadcast_targets
          WHERE session_id = ? AND receiver_id = ? AND responded_at IS NULL
          LIMIT 1`,
          [session.id, receiverId],
        );
        if (!trows.length) {
          await conn.commit();
          return { status: session.status };
        }
        await conn.execute(
          `UPDATE call_broadcast_targets SET responded_at = NOW(3), accepted = 0 WHERE id = ?`,
          [trows[0].id],
        );

        // If all targets rejected, mark session missed
        const [pending]: any = await conn.execute(
          `SELECT COUNT(*) AS c FROM call_broadcast_targets
          WHERE session_id = ? AND responded_at IS NULL`,
          [session.id],
        );
        if (Number(pending[0].c) === 0) {
          await CallModel.updateEnded(
            conn,
            session.id,
            "missed",
            new Date(),
            "user_ended",
          );
          await conn.commit();
          emitToUser(session.caller_id, "call:rejected", { sessionUuid });
        } else {
          await conn.commit();
        }
        return { status: "rejected" };
      }

      // Original non-random behavior
      if (session.receiver_id !== receiverId) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "You are not the assigned receiver.",
        );
      }
      if (
        ["rejected", "missed", "cancelled", "completed", "failed"].includes(
          session.status,
        )
      ) {
        await conn.commit();
        return { status: session.status };
      }
      if (!["initiated", "ringing"].includes(session.status)) {
        throw new AppError(
          400,
          "CALL_NOT_RINGING",
          `Call is ${session.status}.`,
        );
      }

      await CallModel.updateEnded(
        conn,
        session.id,
        "rejected",
        new Date(),
        "user_ended",
      );
      await conn.commit();
      emitToUser(session.caller_id, "call:rejected", { sessionUuid });
      return { status: "rejected" };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Read-only live status of a single call session.
   * Kept as a fallback — the primary mechanism is now socket events.
   * Only visible to the caller or receiver of that session.
   */
  public static async getCallStatus(userId: number, sessionUuid: string) {
    const [rows]: any = await pool.execute(
      `SELECT cs.id, cs.uuid, cs.room_id, cs.status,
              cs.caller_id, cs.receiver_id,
              cs.initiated_at, cs.expires_at, cs.accepted_at, cs.ended_at,
              cs.end_reason,
              caller.nickname AS caller_nickname,
              receiver.nickname AS receiver_nickname
         FROM call_sessions cs
         LEFT JOIN users caller   ON cs.caller_id   = caller.id
         LEFT JOIN users receiver ON cs.receiver_id = receiver.id
        WHERE cs.uuid = ?
        LIMIT 1`,
      [sessionUuid],
    );

    if (!rows.length) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Call session not found.");
    }

    const s = rows[0];
    if (s.caller_id !== userId && s.receiver_id !== userId) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "You are not a participant in this call.",
      );
    }

    const now = Date.now();
    const expiresAt = new Date(s.expires_at).getTime();
    const secondsLeft =
      ["initiated", "ringing"].includes(s.status) && expiresAt > now
        ? Math.floor((expiresAt - now) / 1000)
        : 0;

    return {
      sessionUuid: s.uuid,
      roomId: s.room_id,
      status: s.status,
      callerId: s.caller_id,
      receiverId: s.receiver_id,
      callerNickname: s.caller_nickname,
      receiverNickname: s.receiver_nickname,
      initiatedAt: s.initiated_at,
      acceptedAt: s.accepted_at,
      endedAt: s.ended_at,
      endReason: s.end_reason,
      secondsUntilExpiry: secondsLeft,
    };
  }

  /**
   * Polling fallback for the companion. Deprecated in favour of socket events
   * but retained so a reconnecting client can re-sync its state in one shot.
   */
  public static async getIncomingCall(receiverId: number) {
    const [rows]: any = await pool.execute(
      `SELECT cs.uuid, cs.room_id, cs.caller_id, cs.expires_at, cs.initiated_at,
              u.nickname AS caller_nickname, u.avatar_url AS caller_avatar,
              u.primary_language AS caller_language
         FROM call_sessions cs
         INNER JOIN users u ON cs.caller_id = u.id
        WHERE cs.receiver_id = ?
          AND cs.status IN ('initiated', 'ringing')
          AND cs.expires_at > CURRENT_TIMESTAMP(3)
        ORDER BY cs.id DESC
        LIMIT 1`,
      [receiverId],
    );

    if (!rows.length) return null;

    const r = rows[0];
    const secondsLeft = Math.max(
      0,
      Math.floor((new Date(r.expires_at).getTime() - Date.now()) / 1000),
    );

    return {
      sessionUuid: r.uuid,
      roomId: r.room_id,
      callerId: r.caller_id,
      callerNickname: r.caller_nickname,
      callerAvatar: r.caller_avatar,
      callerLanguage: r.caller_language,
      secondsUntilExpiry: secondsLeft,
    };
  }

  /**
   * Returns the caller's or receiver's own ZEGOCLOUD room token for an
   * accepted call session.
   */
  public static async getRoomToken(userId: number, sessionUuid: string) {
    const [rows]: any = await pool.execute(
      `SELECT id, uuid, room_id, caller_id, receiver_id, status
         FROM call_sessions
        WHERE uuid = ?
        LIMIT 1`,
      [sessionUuid],
    );

    if (!rows.length) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Call session not found.");
    }

    const s = rows[0];

    if (s.caller_id !== userId && s.receiver_id !== userId) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "You are not a participant in this call.",
      );
    }

    if (s.status !== "accepted") {
      throw new AppError(
        409,
        "CALL_NOT_ACCEPTED",
        `Room tokens are only issued for accepted calls. Current status: ${s.status}.`,
      );
    }

    const token = ZegoCloudService.generateRoomToken(String(userId), s.room_id);

    return {
      sessionUuid: s.uuid,
      roomId: s.room_id,
      userId,
      role: s.caller_id === userId ? "caller" : "receiver",
      token,
      expiresInSec: 3600,
    };
  }

  /**
   * Finalizes call session and executes atomic sub-minute settlement.
   * Billing: ceil(duration_seconds / 60) * rates.
   * A 1-second call bills 1 full minute.
   * Emits `call:ended` to both peers after commit.
   */
  public static async endCall(
    sessionUuid: string,
    endReason:
      | "user_ended"
      | "balance_exhausted"
      | "network_drop"
      | "provider_failure"
      | "admin_terminated",
  ) {
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const session = await CallModel.lockSessionByUuid(conn, sessionUuid);
      if (!session) {
        throw new AppError(404, "SESSION_NOT_FOUND", "Call session not found.");
      }

      // Idempotency: skip if already settled
      if (
        ["completed", "failed", "rejected", "missed", "cancelled"].includes(
          session.status,
        )
      ) {
        await conn.commit();
        return { status: session.status, billedMinutes: 0, durationSeconds: 0 };
      }

      const now = new Date();
      let durationSeconds = 0;
      let billedMinutes = 0;

      if (session.accepted_at) {
        durationSeconds = Math.max(
          0,
          Math.floor(
            (now.getTime() - new Date(session.accepted_at).getTime()) / 1000,
          ),
        );
        billedMinutes = Math.ceil(durationSeconds / 60);
      }

      const terminalStatus = session.accepted_at ? "completed" : "missed";

      await CallModel.updateEnded(
        conn,
        session.id,
        terminalStatus,
        now,
        endReason,
      );

      if (billedMinutes > 0) {
        const calculatedDebit = Math.round(billedMinutes * 3.0 * 100) / 100;

        const [callerRows]: any = await conn.execute(
          `SELECT wallet_balance FROM users WHERE id = ? FOR UPDATE`,
          [session.caller_id],
        );
        const currentBalance = parseFloat(callerRows[0]?.wallet_balance || "0");

        const callerDebit = Math.min(
          calculatedDebit,
          Math.max(0, currentBalance),
        );
        const receiverCredit = Math.round(billedMinutes * 1.5 * 100) / 100;
        const platformMargin = Math.max(
          0,
          Math.round((callerDebit - receiverCredit) * 100) / 100,
        );

        const callsHistoryUuid = uuidv4();

        if (callerDebit > 0) {
          await WalletService.mutateBalance(conn, {
            userId: session.caller_id,
            type: "call_debit",
            direction: "debit",
            amount: callerDebit,
            referenceType: "call",
            referenceId: session.id,
            referenceUuid: callsHistoryUuid,
            idempotencyKey: `debit:call:${session.uuid}`,
          });
        }

        if (receiverCredit > 0) {
          await WalletService.mutateBalance(conn, {
            userId: session.receiver_id,
            type: "call_credit",
            direction: "credit",
            amount: receiverCredit,
            referenceType: "call",
            referenceId: session.id,
            referenceUuid: callsHistoryUuid,
            idempotencyKey: `credit:call:${session.uuid}`,
          });
        }

        await CallModel.insertCallHistory(conn, {
          uuid: callsHistoryUuid,
          sessionId: session.id,
          callerId: session.caller_id,
          receiverId: session.receiver_id,
          startTime: new Date(session.accepted_at!),
          endTime: now,
          durationSeconds,
          billedMinutes,
          rateCaller: "3.00",
          rateReceiver: "1.50",
          amountDeducted: callerDebit.toFixed(2),
          amountEarned: receiverCredit.toFixed(2),
          platformMargin: platformMargin.toFixed(2),
        });
      }

      await conn.commit();

      // Emit to both peers
      emitToUser(session.caller_id, "call:ended", {
        sessionUuid,
        endReason,
      });
      emitToUser(session.receiver_id, "call:ended", {
        sessionUuid,
        endReason,
      });

      return { status: terminalStatus, billedMinutes, durationSeconds };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}
