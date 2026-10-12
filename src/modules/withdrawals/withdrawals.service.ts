// src/modules/withdrawals/withdrawals.service.ts
import { v4 as uuidv4 } from "uuid";
import { pool } from "../../config/database.js";
import { WithdrawalModel } from "../../models/withdrawal.model.js";
import { UserModel } from "../../models/user.model.js";
import { WalletModel } from "../../models/wallet.model.js";
import { AdminModel } from "../../models/admin.model.js";
import { AppError } from "../../middleware/error.middleware.js";

export class WithdrawalsService {
  /**
   * Minimum ₹100, 2.5% tax deducted, net credited on admin offline execution.
   */
  public static async requestWithdrawal(
    userId: number,
    amountInput: number,
    upiId: string,
    idempotencyKey: string,
  ) {
    if (amountInput < 100.0) {
      throw new AppError(
        400,
        "MINIMUM_WITHDRAWAL_LIMIT",
        "Minimum withdrawal threshold is ₹100.00.",
      );
    }

    const requestedAmount = Math.round(amountInput * 100) / 100;
    const taxAmount = Math.round(requestedAmount * 0.025 * 100) / 100; // 2.5%
    const netAmount = Math.round((requestedAmount - taxAmount) * 100) / 100;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const user = await UserModel.lockById(conn, userId);
      if (!user)
        throw new AppError(404, "USER_NOT_FOUND", "User record missing.");
      if (user.gender !== "female")
        throw new AppError(
          403,
          "COMPANION_ONLY",
          "Withdrawals restricted to companions.",
        );

      const currentBalance = parseFloat(user.wallet_balance);
      if (currentBalance < requestedAmount) {
        throw new AppError(
          400,
          "INSUFFICIENT_FUNDS",
          "Insufficient balance for requested withdrawal amount.",
        );
      }

      const nextBalance =
        Math.round((currentBalance - requestedAmount) * 100) / 100;
      const withdrawalUuid = uuidv4();

      const withdrawalId = await WithdrawalModel.create(conn, {
        uuid: withdrawalUuid,
        userId,
        requestedAmount: requestedAmount.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        netAmount: netAmount.toFixed(2),
        payoutUpiId: upiId,
        idempotencyKey,
      });

      // Deduct funds immediately into platform escrow reservation
      await WalletModel.insertLedger(conn, {
        uuid: uuidv4(),
        userId,
        type: "withdrawal",
        direction: "debit",
        amount: requestedAmount.toFixed(2),
        balanceBefore: currentBalance.toFixed(2),
        balanceAfter: nextBalance.toFixed(2),
        referenceType: "withdrawal",
        referenceId: withdrawalId,
        idempotencyKey: `reserve:${withdrawalUuid}`,
      });

      await UserModel.updateBalance(conn, userId, nextBalance.toFixed(2));
      await conn.commit();

      return {
        withdrawalUuid,
        requestedAmount,
        taxAmount,
        netAmount,
        status: "pending",
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  public static async settleWithdrawal(
    adminId: number,
    withdrawalId: number,
    action: "paid" | "rejected",
    note?: string,
  ) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const record = await WithdrawalModel.lockById(conn, withdrawalId);
      if (!record || record.status !== "pending") {
        throw new AppError(
          400,
          "INVALID_WITHDRAWAL_STATE",
          "Withdrawal request already finalized or does not exist.",
        );
      }

      if (action === "paid") {
        await WithdrawalModel.updateSettled(
          conn,
          record.id,
          "paid",
          adminId,
          note,
        );
      } else {
        // Refund locked amount back to user's wallet
        const user = await UserModel.lockById(conn, record.user_id);
        const curBal = parseFloat(user!.wallet_balance);
        const refundAmt = parseFloat(record.requested_amount);
        const nextBal = Math.round((curBal + refundAmt) * 100) / 100;

        await WalletModel.insertLedger(conn, {
          uuid: uuidv4(),
          userId: record.user_id,
          type: "withdrawal_refund",
          direction: "credit",
          amount: refundAmt.toFixed(2),
          balanceBefore: curBal.toFixed(2),
          balanceAfter: nextBal.toFixed(2),
          referenceType: "withdrawal",
          referenceId: record.id,
          idempotencyKey: `refund:withdrawal:${record.uuid}`,
        });

        await UserModel.updateBalance(conn, record.user_id, nextBal.toFixed(2));
        await WithdrawalModel.updateSettled(
          conn,
          record.id,
          "rejected",
          adminId,
          note,
        );
      }

      await AdminModel.insertAuditLog({
        adminId,
        action: `withdrawal.${action}`,
        entityType: "withdrawal",
        entityId: String(record.id),
        beforeState: { status: record.status },
        afterState: { status: action, note },
      });

      await conn.commit();
      return { id: record.id, status: action };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}
