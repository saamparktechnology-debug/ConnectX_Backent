// src/modules/auth/admin-password.service.ts
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../../config/database.js";
import { AdminModel } from "../../models/admin.model.js";
import { CryptoUtil } from "../../utils/crypto.util.js";
import { AppError } from "../../middleware/error.middleware.js";

export class AdminPasswordService {
  /**
   * 1. Forgot Password (Dispatches reset token/OTP)
   */
  public static async requestPasswordReset(
    email: string,
  ): Promise<{ debugToken?: string }> {
    const admin = await AdminModel.findByEmail(email);
    if (!admin || !admin.is_active) {
      // Return success anyway to prevent user enumeration attacks
      return {};
    }

    const rawToken = crypto.randomBytes(32).toString("hex"); // 64-char hex token or 6-digit OTP
    const tokenHash = CryptoUtil.sha256(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins expiry

    await pool.execute(
      `INSERT INTO admin_password_resets (admin_id, token_hash, expires_at)
       VALUES (?, ?, ?)`,
      [admin.id, tokenHash, expiresAt],
    );

    // TODO: Send via SMTP/SendGrid/SES email provider
    // await MailerService.sendResetPasswordEmail(admin.email, rawToken);

    return process.env.NODE_ENV !== "production"
      ? { debugToken: rawToken }
      : {};
  }

  /**
   * 2. Reset Password (Using Token/OTP)
   */
  public static async resetPassword(
    email: string,
    rawToken: string,
    newPasswordPlain: string,
  ): Promise<void> {
    const admin = await AdminModel.findByEmail(email);
    if (!admin || !admin.is_active) {
      throw new AppError(
        400,
        "INVALID_REQUEST",
        "Invalid or expired reset token.",
      );
    }

    const tokenHash = CryptoUtil.sha256(rawToken);
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const [resets]: any = await conn.execute(
        `SELECT id FROM admin_password_resets 
         WHERE admin_id = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [admin.id, tokenHash],
      );

      if (!resets.length) {
        throw new AppError(
          400,
          "INVALID_OR_EXPIRED_TOKEN",
          "Reset token is invalid or has expired.",
        );
      }

      // Hash new password using bcrypt cost 12
      const newHash = await bcrypt.hash(newPasswordPlain, 12);

      // Update password
      await conn.execute(
        `UPDATE admins SET password_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [newHash, admin.id],
      );

      // Invalidate the reset token
      await conn.execute(
        `UPDATE admin_password_resets SET consumed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [resets[0].id],
      );

      // Revoke all existing admin refresh token families to force re-login everywhere
      await conn.execute(
        `UPDATE admin_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3) WHERE admin_id = ?`,
        [admin.id],
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 3. Change Password (Authenticated inside Admin Panel)
   */
  public static async changePassword(
    adminId: number,
    oldPasswordPlain: string,
    newPasswordPlain: string,
  ): Promise<void> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM admins WHERE id = ?`,
      [adminId],
    );
    if (!rows.length) {
      throw new AppError(404, "ADMIN_NOT_FOUND", "Admin record not found.");
    }

    const admin = rows[0];
    const isOldValid = await bcrypt.compare(
      oldPasswordPlain,
      admin.password_hash,
    );
    if (!isOldValid) {
      throw new AppError(
        400,
        "INCORRECT_OLD_PASSWORD",
        "The current password provided is incorrect.",
      );
    }

    const newHash = await bcrypt.hash(newPasswordPlain, 12);
    await pool.execute(
      `UPDATE admins SET password_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [newHash, adminId],
    );
  }
}
