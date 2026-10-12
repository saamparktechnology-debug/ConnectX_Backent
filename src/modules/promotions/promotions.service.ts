// src/modules/promotions/promotions.service.ts
import { PoolConnection } from "mysql2/promise";
import { v4 as uuidv4 } from "uuid";
import { WalletModel } from "../../models/wallet.model.js";
import { UserModel } from "../../models/user.model.js";

export class PromotionsService {
  /**
   * Evaluates active promotions on onboarding completion and credits wallet idempotently.
   */
  public static async evaluateOnboardingPromotions(
    conn: PoolConnection,
    userId: number,
    gender: "male" | "female",
  ): Promise<void> {
    // 1. Find active promotions matching user gender
    const [promotions]: any = await conn.execute(
      `SELECT * FROM wallet_promotions 
       WHERE is_active = TRUE 
         AND target_gender IN (?, 'all')
         AND starts_at <= CURRENT_TIMESTAMP(3) 
         AND ends_at > CURRENT_TIMESTAMP(3)`,
      [gender],
    );

    for (const promo of promotions) {
      // 2. Check if already granted
      const [grants]: any = await conn.execute(
        `SELECT promotion_id FROM wallet_promotion_grants WHERE promotion_id = ? AND user_id = ?`,
        [promo.id, userId],
      );

      if (grants.length > 0) continue; // Already granted

      const promoAmount = parseFloat(promo.amount);
      const user = await UserModel.lockById(conn, userId);
      const curBal = parseFloat(user!.wallet_balance);
      const nextBal = Math.round((curBal + promoAmount) * 100) / 100;
      const txUuid = uuidv4();

      // Ledger credit
      const txnId = await WalletModel.insertLedger(conn, {
        uuid: txUuid,
        userId,
        type: "promotion",
        direction: "credit",
        amount: promoAmount.toFixed(2),
        balanceBefore: curBal.toFixed(2),
        balanceAfter: nextBal.toFixed(2),
        referenceType: "promotion",
        referenceId: promo.id,
        idempotencyKey: `promo:${promo.id}:user:${userId}`,
      });

      // Update user wallet balance cache
      await UserModel.updateBalance(conn, userId, nextBal.toFixed(2));

      // Record promotion grant
      await conn.execute(
        `INSERT INTO wallet_promotion_grants (promotion_id, user_id, txn_id)
         VALUES (?, ?, ?)`,
        [promo.id, userId, txnId],
      );
    }
  }
}
