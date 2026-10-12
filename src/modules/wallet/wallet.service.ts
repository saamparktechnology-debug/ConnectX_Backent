import { PoolConnection } from "mysql2/promise";
import { v4 as uuidv4 } from "uuid";
import { AppError } from "../../middleware/error.middleware.js";
import { emitToUser } from "../../socket/socket.server.js";

export interface WalletMutationParams {
  userId: number;
  type:
    | "recharge"
    | "call_debit"
    | "call_credit"
    | "withdrawal"
    | "withdrawal_refund"
    | "promotion"
    | "admin_adjustment";
  direction: "credit" | "debit";
  amount: number;
  referenceType:
    | "recharge"
    | "call"
    | "withdrawal"
    | "promotion"
    | "admin_adjustment";
  referenceId: number;
  referenceUuid?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, any>;
}

export class WalletService {
  /**
   * Executes an atomic wallet balance mutation under a strict pessimistic row lock.
   * Invariant verified against chk_wt_balance_math and chk_wt_reference_shape.
   * Emits `wallet:updated` to the user's socket room on success.
   */
  public static async mutateBalance(
    conn: PoolConnection,
    params: WalletMutationParams,
  ): Promise<{
    balanceBefore: number;
    balanceAfter: number;
    transactionUuid: string;
  }> {
    // 1. Lock the user's record
    const [rows]: any = await conn.execute(
      `SELECT id, wallet_balance, account_state FROM users WHERE id = ? FOR UPDATE`,
      [params.userId],
    );

    if (!rows || rows.length === 0) {
      throw new AppError(
        404,
        "USER_NOT_FOUND",
        `User with ID ${params.userId} not found.`,
      );
    }

    if (rows[0].account_state !== "active") {
      throw new AppError(
        403,
        "ACCOUNT_NOT_ACTIVE",
        `Account status is ${rows[0].account_state}.`,
      );
    }

    const currentBalance = parseFloat(rows[0].wallet_balance);
    const mutationAmount = Math.round(params.amount * 100) / 100;

    if (mutationAmount <= 0) {
      throw new AppError(
        400,
        "INVALID_AMOUNT",
        "Mutation amount must be strictly positive.",
      );
    }

    let nextBalance: number;
    if (params.direction === "debit") {
      if (currentBalance < mutationAmount) {
        throw new AppError(
          400,
          "INSUFFICIENT_BALANCE",
          "Wallet balance is insufficient for this debit.",
        );
      }
      nextBalance = Math.round((currentBalance - mutationAmount) * 100) / 100;
    } else {
      nextBalance = Math.round((currentBalance + mutationAmount) * 100) / 100;
    }

    const transactionUuid = uuidv4();

    // 2. Append-only ledger write
    await conn.execute(
      `INSERT INTO wallet_transactions 
       (uuid, user_id, type, direction, amount, balance_before, balance_after, 
        reference_type, reference_id, reference_uuid, idempotency_key, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionUuid,
        params.userId,
        params.type,
        params.direction,
        mutationAmount.toFixed(2),
        currentBalance.toFixed(2),
        nextBalance.toFixed(2),
        params.referenceType,
        params.referenceId,
        params.referenceUuid ?? null,
        params.idempotencyKey ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ],
    );

    // 3. Sync materialized balance cache column
    await conn.execute(
      `UPDATE users SET wallet_balance = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [nextBalance.toFixed(2), params.userId],
    );

    // 4. Emit live balance update to the user's sockets
    emitToUser(params.userId, "wallet:updated", {
      balance: nextBalance.toFixed(2),
    });

    return {
      balanceBefore: currentBalance,
      balanceAfter: nextBalance,
      transactionUuid,
    };
  }
}
