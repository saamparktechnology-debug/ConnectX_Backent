import { pool } from "../../config/database.js";
import { v4 as uuidv4 } from "uuid";
import { AppError } from "../../middleware/error.middleware.js";
import { WalletService } from "../wallet/wallet.service.js";
import { emitToUser } from "../../socket/socket.server.js";
import { logger } from "../../utils/logger.util.js";

export interface FemaleTargetRow {
  id: number;
  user_id: number;
  period_year: number;
  period_month: number;
  target_minutes: number;
  prize_amount: string;
  notes: string | null;
}

export class TargetsService {
  /** Admin: create or update a female's target for a specific month. */
  public static async upsertTarget(
    adminId: number,
    userId: number,
    periodYear: number,
    periodMonth: number,
    targetMinutes: number,
    prizeAmount: number,
    notes?: string,
  ) {
    if (periodMonth < 1 || periodMonth > 12) {
      throw new AppError(400, "INVALID_MONTH", "Month must be 1–12.");
    }
    if (targetMinutes <= 0) {
      throw new AppError(400, "INVALID_TARGET", "Target must be > 0.");
    }
    if (prizeAmount <= 0) {
      throw new AppError(400, "INVALID_PRIZE", "Prize must be > 0.");
    }

    const [userRows]: any = await pool.execute(
      `SELECT id, gender FROM users WHERE id = ? AND deleted_at IS NULL`,
      [userId],
    );
    if (!userRows.length) {
      throw new AppError(404, "USER_NOT_FOUND", "User not found.");
    }
    if (userRows[0].gender !== "female") {
      throw new AppError(
        400,
        "NOT_FEMALE",
        "Targets can only be set for female users.",
      );
    }

    await pool.execute(
      `INSERT INTO female_targets
         (user_id, period_year, period_month, target_minutes, prize_amount, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         target_minutes = VALUES(target_minutes),
         prize_amount   = VALUES(prize_amount),
         notes          = VALUES(notes),
         created_by     = VALUES(created_by),
         updated_at     = NOW(3)`,
      [
        userId,
        periodYear,
        periodMonth,
        targetMinutes,
        prizeAmount,
        notes ?? null,
        adminId,
      ],
    );

    return this.getTargetForUserMonth(userId, periodYear, periodMonth);
  }

  /** Read one target + current progress. */
  public static async getTargetForUserMonth(
    userId: number,
    periodYear: number,
    periodMonth: number,
  ) {
    const [targetRows]: any = await pool.execute(
      `SELECT * FROM female_targets
        WHERE user_id = ? AND period_year = ? AND period_month = ?
        LIMIT 1`,
      [userId, periodYear, periodMonth],
    );
    if (!targetRows.length) return null;

    const target: FemaleTargetRow = targetRows[0];

    const [progressRows]: any = await pool.execute(
      `SELECT COALESCE(SUM(ch.billed_minutes), 0) AS total_minutes
         FROM calls_history ch
        WHERE ch.receiver_id = ?
          AND YEAR(ch.end_time) = ?
          AND MONTH(ch.end_time) = ?`,
      [userId, periodYear, periodMonth],
    );
    const achievedMinutes = Number(progressRows[0]?.total_minutes ?? 0);

    const [awardRows]: any = await pool.execute(
      `SELECT id, awarded_at, prize_amount FROM female_target_awards
        WHERE user_id = ? AND period_year = ? AND period_month = ?
        LIMIT 1`,
      [userId, periodYear, periodMonth],
    );

    return {
      id: target.id,
      userId: target.user_id,
      periodYear: target.period_year,
      periodMonth: target.period_month,
      targetMinutes: target.target_minutes,
      prizeAmount: target.prize_amount,
      notes: target.notes,
      achievedMinutes,
      isComplete: achievedMinutes >= target.target_minutes,
      progressPercent: Math.min(
        100,
        Math.round((achievedMinutes / target.target_minutes) * 100),
      ),
      awarded:
        awardRows.length > 0
          ? {
              awardedAt: awardRows[0].awarded_at,
              prizeAmount: awardRows[0].prize_amount,
            }
          : null,
    };
  }

  /** Female reads her target for a month (defaults to current month). */
  public static async getMyTarget(
    userId: number,
    year?: number,
    month?: number,
  ) {
    const now = new Date();
    const y = year ?? now.getUTCFullYear();
    const m = month ?? now.getUTCMonth() + 1;
    return this.getTargetForUserMonth(userId, y, m);
  }

  /**
   * Award all pending targets for a given (year, month).
   * Idempotent — the UNIQUE(user_id, year, month) on awards table prevents dupes.
   * Called by cron at month end.
   */
  public static async awardCompletedTargets(year: number, month: number) {
    const [targets]: any = await pool.execute(
      `SELECT ft.*, 
              (SELECT COALESCE(SUM(ch.billed_minutes), 0)
                 FROM calls_history ch
                WHERE ch.receiver_id = ft.user_id
                  AND YEAR(ch.end_time) = ft.period_year
                  AND MONTH(ch.end_time) = ft.period_month) AS achieved_minutes
         FROM female_targets ft
        WHERE ft.period_year = ? AND ft.period_month = ?`,
      [year, month],
    );

    let awarded = 0;
    for (const t of targets) {
      const achieved = Number(t.achieved_minutes);
      if (achieved < t.target_minutes) continue;

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Check for existing award (idempotent)
        const [existing]: any = await conn.execute(
          `SELECT id FROM female_target_awards
            WHERE user_id = ? AND period_year = ? AND period_month = ?
            FOR UPDATE`,
          [t.user_id, year, month],
        );
        if (existing.length > 0) {
          await conn.commit();
          continue;
        }

        const txnUuid = uuidv4();
        const prize = parseFloat(t.prize_amount);

        const { transactionUuid } = await WalletService.mutateBalance(conn, {
          userId: t.user_id,
          type: "admin_adjustment",
          direction: "credit",
          amount: prize,
          referenceType: "admin_adjustment",
          referenceId: t.id,
          idempotencyKey: `target-award:${t.user_id}:${year}-${month}`,
          metadata: {
            kind: "monthly_target_prize",
            targetMinutes: t.target_minutes,
            achievedMinutes: achieved,
            period: `${year}-${String(month).padStart(2, "0")}`,
          },
        });

        // WalletService inserts the ledger and returns the txn uuid; we need id for FK
        const [txnRows]: any = await conn.execute(
          `SELECT id FROM wallet_transactions WHERE uuid = ?`,
          [transactionUuid],
        );

        await conn.execute(
          `INSERT INTO female_target_awards
             (target_id, user_id, period_year, period_month,
              achieved_minutes, prize_amount, txn_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            t.id,
            t.user_id,
            year,
            month,
            achieved,
            prize.toFixed(2),
            txnRows[0].id,
          ],
        );

        await conn.commit();

        // Notify via socket
        emitToUser(t.user_id, "target:awarded", {
          periodYear: year,
          periodMonth: month,
          achievedMinutes: achieved,
          prizeAmount: prize.toFixed(2),
        });
        awarded++;
      } catch (err) {
        await conn.rollback();
        logger.error({ err, userId: t.user_id }, "target award failed");
      } finally {
        conn.release();
      }
    }

    logger.info(
      { year, month, awarded, total: targets.length },
      "targets awarded",
    );
    return { year, month, awarded, total: targets.length };
  }

  /** Admin listing — all targets for a period. */
  public static async listByPeriod(year: number, month: number) {
    const [rows]: any = await pool.execute(
      `SELECT ft.*, u.public_id, u.nickname, u.phone,
              (SELECT COALESCE(SUM(ch.billed_minutes), 0)
                 FROM calls_history ch
                WHERE ch.receiver_id = ft.user_id
                  AND YEAR(ch.end_time) = ft.period_year
                  AND MONTH(ch.end_time) = ft.period_month) AS achieved_minutes,
              (SELECT id FROM female_target_awards a
                WHERE a.user_id = ft.user_id
                  AND a.period_year = ft.period_year
                  AND a.period_month = ft.period_month) AS award_id
         FROM female_targets ft
         INNER JOIN users u ON u.id = ft.user_id
        WHERE ft.period_year = ? AND ft.period_month = ?
        ORDER BY ft.created_at DESC`,
      [year, month],
    );
    return rows.map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      publicId: r.public_id,
      nickname: r.nickname,
      phone: r.phone,
      periodYear: r.period_year,
      periodMonth: r.period_month,
      targetMinutes: r.target_minutes,
      prizeAmount: r.prize_amount,
      notes: r.notes,
      achievedMinutes: Number(r.achieved_minutes ?? 0),
      isComplete: Number(r.achieved_minutes ?? 0) >= r.target_minutes,
      awarded: r.award_id != null,
      createdAt: r.created_at,
    }));
  }

  public static async deleteTarget(adminId: number, targetId: number) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [award]: any = await conn.execute(
        `SELECT id FROM female_target_awards WHERE target_id = ? LIMIT 1`,
        [targetId],
      );
      if (award.length > 0) {
        throw new AppError(
          409,
          "ALREADY_AWARDED",
          "Cannot delete — prize already awarded.",
        );
      }

      const [result]: any = await conn.execute(
        `DELETE FROM female_targets WHERE id = ?`,
        [targetId],
      );
      if (result.affectedRows === 0) {
        throw new AppError(404, "TARGET_NOT_FOUND", "Target not found.");
      }

      await conn.commit();
      return { deleted: true };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}
