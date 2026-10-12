// src/modules/recharges/recharges.service.ts
import { pool } from "../../config/database.js";
import { v4 as uuidv4 } from "uuid";
import { env } from "../../config/env.js";
import { PayUService } from "./payu.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { AppError } from "../../middleware/error.middleware.js";
import { logger } from "../../utils/logger.util.js";

export class RechargesService {
  public static async initiateRecharge(
    userId: number,
    baseAmountInput: number,
    idempotencyKey: string,
  ) {
    if (baseAmountInput < 10.0 || baseAmountInput > 50000.0) {
      throw new AppError(
        400,
        "INVALID_RECHARGE_LIMITS",
        "Base recharge must be between ₹10 and ₹50,000.",
      );
    }

    const baseAmount = Math.round(baseAmountInput * 100) / 100;
    // DECIDED: 4% tax added on top
    const taxAmount = Math.round(baseAmount * 0.04 * 100) / 100;
    const totalAmount = Math.round((baseAmount + taxAmount) * 100) / 100;

    const [userRows]: any = await pool.execute(
      `SELECT nickname, phone FROM users WHERE id = ?`,
      [userId],
    );
    if (!userRows.length)
      throw new AppError(404, "USER_NOT_FOUND", "User record not found.");

    const user = userRows[0];
    const rechargeUuid = uuidv4();

    const forwardHash = PayUService.generatePaymentHash({
      txnid: rechargeUuid,
      amount: totalAmount.toFixed(2),
      productinfo: "Wallet Recharge",
      firstname: user.nickname,
      email: `${user.phone.replace(/[^0-9]/g, "")}@connect24x.internal`,
    });

    await pool.execute(
      `INSERT INTO recharges 
       (uuid, user_id, base_amount, tax_amount, total_amount, currency, status, pg_provider, pg_hash, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'INR', 'pending', 'payu', ?, ?)`,
      [
        rechargeUuid,
        userId,
        baseAmount.toFixed(2),
        taxAmount.toFixed(2),
        totalAmount.toFixed(2),
        forwardHash,
        idempotencyKey,
      ],
    );

    return {
      rechargeUuid,
      payuCheckoutUrl: `${env.PAYU_BASE_URL}/_payment`,
      params: {
        key: env.PAYU_MERCHANT_KEY,
        txnid: rechargeUuid,
        amount: totalAmount.toFixed(2),
        productinfo: "Wallet Recharge",
        firstname: user.nickname,
        email: `${user.phone.replace(/[^0-9]/g, "")}@connect24x.internal`,
        phone: user.phone,
        surl: env.PAYU_SUCCESS_URL,
        furl: env.PAYU_FAILURE_URL,
        hash: forwardHash,
      },
    };
  }

  public static async processCallback(
    payload: Record<string, string>,
  ): Promise<void> {
    const isValidHash = PayUService.verifyCallbackHash(payload);
    if (!isValidHash) {
      logger.warn(
        { txnid: payload.txnid },
        "PayU callback rejected due to invalid reverse hash signature",
      );
      throw new AppError(
        400,
        "INVALID_PAYU_HASH",
        "Callback hash verification failed",
      );
    }

    const { txnid, mihpayid, status } = payload;
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // Audit raw payload in payment_transactions
      const [existingPt]: any = await conn.execute(
        `SELECT id, processed FROM payment_transactions WHERE provider = 'payu' AND provider_txn_id = ? FOR UPDATE`,
        [mihpayid],
      );

      if (existingPt.length > 0 && existingPt[0].processed) {
        await conn.commit();
        return; // Idempotent no-op
      }

      const [rechargeRows]: any = await conn.execute(
        `SELECT * FROM recharges WHERE uuid = ? FOR UPDATE`,
        [txnid],
      );

      if (!rechargeRows.length) {
        throw new AppError(
          404,
          "RECHARGE_NOT_FOUND",
          `Recharge ${txnid} not found.`,
        );
      }

      const recharge = rechargeRows[0];

      if (recharge.status === "success") {
        await conn.commit();
        return;
      }

      if (existingPt.length === 0) {
        await conn.execute(
          `INSERT INTO payment_transactions 
           (provider, event_type, provider_txn_id, raw_payload, recharge_id, processed)
           VALUES ('payu', ?, ?, ?, ?, FALSE)`,
          [status, mihpayid, JSON.stringify(payload), recharge.id],
        );
      }

      if (status === "success") {
        await conn.execute(
          `UPDATE recharges 
           SET status = 'success', pg_txn_id = ?, pg_status = ?, updated_at = CURRENT_TIMESTAMP(3) 
           WHERE id = ?`,
          [mihpayid, status, recharge.id],
        );

        // Credit the male user's wallet with base_amount (excluding the 4% platform tax)
        await WalletService.mutateBalance(conn, {
          userId: recharge.user_id,
          type: "recharge",
          direction: "credit",
          amount: parseFloat(recharge.base_amount),
          referenceType: "recharge",
          referenceId: recharge.id,
          idempotencyKey: `recharge:${recharge.uuid}`,
          metadata: { mihpayid, total_paid: recharge.total_amount },
        });
      } else {
        await conn.execute(
          `UPDATE recharges 
           SET status = 'failed', pg_txn_id = ?, pg_status = ?, updated_at = CURRENT_TIMESTAMP(3) 
           WHERE id = ?`,
          [mihpayid, status, recharge.id],
        );
      }

      await conn.execute(
        `UPDATE payment_transactions SET processed = TRUE WHERE provider = 'payu' AND provider_txn_id = ?`,
        [mihpayid],
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  public static async manualReconcile(
    adminId: number,
    rechargeId: number,
    adminNote: string,
  ): Promise<{ id: number; status: string }> {
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const [rechargeRows]: any = await conn.execute(
        `SELECT * FROM recharges WHERE id = ? FOR UPDATE`,
        [rechargeId],
      );

      if (!rechargeRows.length) {
        throw new AppError(
          404,
          "RECHARGE_NOT_FOUND",
          "Recharge record not found.",
        );
      }

      const recharge = rechargeRows[0];

      if (recharge.status === "success") {
        throw new AppError(
          400,
          "ALREADY_SUCCESS",
          "Recharge is already marked as success.",
        );
      }

      // Update recharge status
      await conn.execute(
        `UPDATE recharges 
         SET status = 'success', 
             pg_status = 'manual_admin_reconciled',
             updated_at = CURRENT_TIMESTAMP(3) 
         WHERE id = ?`,
        [recharge.id],
      );

      // Mutate wallet balance atomically with base_amount
      await WalletService.mutateBalance(conn, {
        userId: recharge.user_id,
        type: "recharge",
        direction: "credit",
        amount: parseFloat(recharge.base_amount),
        referenceType: "recharge",
        referenceId: recharge.id,
        idempotencyKey: `manual_reconcile:${recharge.uuid}`,
        metadata: {
          reconciled_by_admin: adminId,
          admin_note: adminNote,
          original_total_paid: recharge.total_amount,
        },
      });

      // Write audit log
      await conn.execute(
        `INSERT INTO admin_audit_logs 
         (admin_id, action, target_type, target_id, details)
         VALUES (?, 'RECHARGE_MANUAL_RECONCILE', 'recharge', ?, ?)`,
        [
          adminId,
          recharge.id,
          JSON.stringify({ adminNote, rechargeUuid: recharge.uuid }),
        ],
      );

      await conn.commit();
      return { id: recharge.id, status: "success" };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}
