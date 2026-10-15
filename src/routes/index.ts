// src/routes/index.ts
import { Router } from "express";
import { authenticate, requireAdmin } from "../middleware/auth.middleware.js";
import { validateRequest } from "../middleware/validate.middleware.js";
import { idempotency } from "../middleware/idempotency.middleware.js";
import {
  otpSendRateLimiter,
  otpVerifyRateLimiter,
  callInitiationRateLimiter,
  financialRateLimiter,
} from "../middleware/rate-limiter.middleware.js";
import {
  SendOtpSchema,
  VerifyOtpSchema,
  InitiateCallSchema,
  InitiateRechargeSchema,
  RequestWithdrawalSchema,
  SubmitRatingSchema,
  AdminReviewVerificationSchema,
} from "../validations/index.js";

import { AuthService } from "../modules/auth/auth.service.js";
import { CallsService } from "../modules/calls/calls.service.js";
import { RechargesService } from "../modules/recharges/recharges.service.js";
import { WithdrawalsService } from "../modules/withdrawals/withdrawals.service.js";
import { VerificationService } from "../modules/verification/verification.service.js";
import { RatingsService } from "../modules/ratings/ratings.service.js";
import { PromotionsService } from "../modules/promotions/promotions.service.js";
import { UsersService } from "../modules/users/users.service.js";
import { AdminPasswordService } from "../modules/auth/admin-password.service.js";

import { UserModel } from "../models/user.model.js";
import { WalletModel } from "../models/wallet.model.js";
import { WithdrawalModel } from "../models/withdrawal.model.js";
import { VerificationModel } from "../models/verification.model.js";
import { RatingModel } from "../models/rating.model.js";
import { CryptoUtil } from "../utils/crypto.util.js";
import { AuthenticatedRequest } from "../types/common.js";
import { pool } from "../config/database.js";
import { RechargeModel } from "../models/recharge.model.js";
import { CallModel } from "../models/call.model.js";
import { uuidv4 } from "zod/v4";
import { WalletService } from "../modules/wallet/wallet.service.js";
import { uploadVoice } from "../middleware/upload.middleware.js";
import { env } from "../config/env.js"; // for PUBLIC_BASE_URL (see below)
import { AppError } from "../middleware/error.middleware.js";
import { AuthModel } from "../models/auth.model.js";
import { uploadAvatar } from "../middleware/avatar-upload.middleware.js";
export const apiRouter = Router();

// ============================================================================
// 1. AUTHENTICATION (MOBILE & ADMIN)
// ============================================================================
apiRouter.post(
  "/auth/otp/send",
  otpSendRateLimiter,
  validateRequest({ body: SendOtpSchema }),
  async (req, res, next) => {
    try {
      const result = await AuthService.sendOtp(req.body.phone);
      res.json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/auth/otp/verify",
  otpVerifyRateLimiter,
  validateRequest({ body: VerifyOtpSchema }),
  async (req, res, next) => {
    try {
      const { phone, otp, deviceId } = req.body;
      const session = await AuthService.verifyOtp(phone, otp, deviceId);

      res.json({
        success: true,
        data: session,
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post("/users/onboarding/create", async (req, res, next) => {
  try {
    const { onboardingToken, gender, nickname, birthYear, avatarUrl } =
      req.body as {
        onboardingToken: string;
        gender: "male" | "female";
        nickname: string;
        birthYear?: number | null;
        avatarUrl?: string | null;
      };

    if (!onboardingToken) {
      throw new AppError(400, "MISSING_TOKEN", "Onboarding token required.");
    }
    if (gender !== "male" && gender !== "female") {
      throw new AppError(
        400,
        "INVALID_GENDER",
        "Gender must be male or female.",
      );
    }
    if (
      !nickname ||
      nickname.trim().length < 2 ||
      nickname.trim().length > 64
    ) {
      throw new AppError(
        400,
        "INVALID_NICKNAME",
        "Nickname must be 2–64 characters.",
      );
    }

    const session = await AuthService.completeSignup(onboardingToken, {
      gender,
      nickname: nickname.trim(),
      birthYear:
        gender === "female" ? (birthYear ?? null) : (birthYear ?? null),
      avatarUrl: avatarUrl ?? null,
    });
    res.status(201).json({ success: true, data: session, error: null });
  } catch (e) {
    next(e);
  }
});

apiRouter.post("/auth/token/refresh", async (req, res, next) => {
  try {
    const rotated = await AuthService.refreshAccessToken(req.body.refreshToken);
    res.json({ success: true, data: rotated, error: null });
  } catch (e) {
    next(e);
  }
});

apiRouter.post("/auth/logout", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      // Hash and revoke — same as admin logout semantics
      const crypto = await import("node:crypto");
      const hash = crypto
        .createHash("sha256")
        .update(refreshToken)
        .digest("hex");
      await pool.execute(
        `UPDATE auth_refresh_tokens 
         SET revoked_at = CURRENT_TIMESTAMP(3) 
         WHERE token_hash = ? AND revoked_at IS NULL`,
        [hash],
      );
    }
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) {
    next(e);
  }
});

apiRouter.post("/admin/auth/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    console.log("Admin login attempt:", email, password); // Debugging line
    const session = await AuthService.adminLogin(email, password);
    res.json({ success: true, data: session, error: null });
  } catch (e) {
    next(e);
  }
});

apiRouter.post("/admin/auth/forgot-password", async (req, res, next) => {
  try {
    const result = await AdminPasswordService.requestPasswordReset(
      req.body.email,
    );
    res.json({ success: true, data: result, error: null });
  } catch (e) {
    next(e);
  }
});

apiRouter.post("/admin/auth/reset-password", async (req, res, next) => {
  try {
    const { email, token, newPassword } = req.body;
    await AdminPasswordService.resetPassword(email, token, newPassword);
    res.json({
      success: true,
      data: { message: "Password reset successfully" },
      error: null,
    });
  } catch (e) {
    next(e);
  }
});

apiRouter.post(
  "/admin/auth/change-password",
  requireAdmin,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { oldPassword, newPassword } = req.body;
      await AdminPasswordService.changePassword(
        req.user!.id,
        oldPassword,
        newPassword,
      );
      res.json({
        success: true,
        data: { message: "Password changed successfully" },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ============================================================================
// 2. ONBOARDING & PROFILE KYC
// ============================================================================
apiRouter.post(
  "/users/onboarding/complete",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const {
        realName,
        idNumber,
        idName,
        birthYear,
        primaryLanguage,
        avatarUrl,
      } = req.body;

      // Basic validation — keep it light here; add Zod later if needed.
      if (!birthYear) {
        throw new AppError(
          400,
          "BIRTH_YEAR_REQUIRED",
          "Birth year is required.",
        );
      }
      if (!primaryLanguage) {
        throw new AppError(
          400,
          "PRIMARY_LANGUAGE_REQUIRED",
          "Primary language is required.",
        );
      }

      const encryptedId = CryptoUtil.encryptAES256GCM(idNumber ?? "");

      await UserModel.saveKYCAndOnboarding(conn, req.user!.id, {
        realName: realName ?? "",
        idNumberEncrypted: encryptedId,
        idName: idName ?? "",
        birthYear: parseInt(String(birthYear), 10),
        primaryLanguage,
        avatarUrl: avatarUrl ?? null,
      });

      // Check & credit eligible welcome promotions
      await PromotionsService.evaluateOnboardingPromotions(
        conn,
        req.user!.id,
        req.user!.gender,
      );

      await conn.commit();
      res.json({
        success: true,
        data: { status: "onboarding_completed" },
        error: null,
      });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  },
);

apiRouter.get(
  "/users/me",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const user = await UserModel.findById(req.user!.id);
      if (!user) {
        throw new AppError(404, "USER_NOT_FOUND", "User not found.");
      }

      // Fetch the most recent rejection reason (if any)
      let rejectionReason: string | null = null;
      let rejectionNote: string | null = null;

      if (user.verification_status === "rejected") {
        const [rejRows]: any = await pool.execute(
          `SELECT rejection_reason_code, rejection_reason_note
             FROM verification_submissions
            WHERE user_id = ? AND status = 'rejected'
            ORDER BY id DESC
            LIMIT 1`,
          [user.id],
        );
        if (rejRows.length > 0) {
          rejectionReason = rejRows[0].rejection_reason_code ?? null;
          rejectionNote = rejRows[0].rejection_reason_note ?? null;
        }
      }

      res.json({
        success: true,
        data: {
          id: user.id,
          uuid: user.uuid,
          publicId: user.public_id,
          phone: user.phone,
          gender: user.gender,
          nickname: user.nickname,
          avatarUrl: user.avatar_url,
          primaryLanguage: user.primary_language,
          verificationStatus: user.verification_status,
          verificationRejectionReason: rejectionReason,
          verificationRejectionNote: rejectionNote,
          accountState: user.account_state,
          isOnline: Boolean(user.is_online),
          walletBalance: user.wallet_balance,
          onboardingCompleted: Boolean(user.onboarding_completed_at),
          birthYear: user.birth_year,
          termsAcceptedAt: user.terms_accepted_at,
          channelsAcknowledgedAt: user.channels_acknowledged_at,
        },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.patch(
  "/users/me",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { nickname, avatarUrl, primaryLanguage } = req.body;
      const userId = req.user!.id;

      const updates: string[] = [];
      const params: any[] = [];

      // ── Nickname ─────────────────────────────────────────────
      if (typeof nickname === "string") {
        const trimmed = nickname.trim();
        if (trimmed.length < 2 || trimmed.length > 64) {
          throw new AppError(
            400,
            "INVALID_NICKNAME",
            "Nickname must be 2–64 characters.",
          );
        }
        updates.push("nickname = ?");
        params.push(trimmed);
      }

      // ── Avatar URL ───────────────────────────────────────────
      if (typeof avatarUrl === "string" || avatarUrl === null) {
        if (avatarUrl !== null && avatarUrl.length > 512) {
          throw new AppError(400, "INVALID_AVATAR_URL", "Avatar URL too long.");
        }
        updates.push("avatar_url = ?");
        params.push(avatarUrl);
      }

      // ── Primary Language ─────────────────────────────────────
      if (typeof primaryLanguage === "string") {
        const [langRows]: any = await pool.execute(
          `SELECT code FROM languages WHERE code = ? AND is_active = TRUE LIMIT 1`,
          [primaryLanguage],
        );
        if (langRows.length === 0) {
          throw new AppError(
            400,
            "INVALID_LANGUAGE",
            `Language '${primaryLanguage}' is not supported.`,
          );
        }
        updates.push("primary_language = ?");
        params.push(primaryLanguage);
      }

      if (updates.length === 0) {
        throw new AppError(400, "NO_UPDATES", "No valid fields to update.");
      }

      updates.push("updated_at = CURRENT_TIMESTAMP(3)");
      params.push(userId);

      await pool.execute(
        `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
        params,
      );

      const user = await UserModel.findById(userId);
      if (!user) {
        throw new AppError(404, "USER_NOT_FOUND", "User not found.");
      }

      res.json({
        success: true,
        data: {
          nickname: user.nickname,
          avatarUrl: user.avatar_url,
          primaryLanguage: user.primary_language,
        },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/users/avatar",
  authenticate,
  uploadAvatar,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!req.file) {
        throw new AppError(
          400,
          "NO_FILE",
          "No image received under field 'avatar'.",
        );
      }

      const publicBase =
        process.env.PUBLIC_BASE_URL ||
        `http://localhost:${process.env.PORT || 5000}`;
      const avatarUrl = `${publicBase}/uploads/avatars/${req.file.filename}`;

      // Persist the URL on the user row so it survives across devices
      await pool.execute(
        `UPDATE users SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [avatarUrl, req.user!.id],
      );

      res.status(201).json({
        success: true,
        data: {
          avatarUrl,
          sizeBytes: req.file.size,
          mime: req.file.mimetype,
        },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/users/devices/push-token",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { deviceId, platform, pushToken } = req.body as {
        deviceId: string;
        platform: "ios" | "android";
        pushToken: string;
      };

      if (!deviceId || !platform || !pushToken) {
        throw new AppError(
          400,
          "MISSING_FIELDS",
          "deviceId, platform, pushToken required.",
        );
      }

      await pool.execute(
        `INSERT INTO user_devices (user_id, device_id, platform, push_token, push_enabled)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           platform = VALUES(platform),
           push_token = VALUES(push_token),
           push_enabled = 1,
           last_active_at = NOW(3)`,
        [req.user!.id, deviceId, platform, pushToken],
      );

      res.json({ success: true, data: { ok: true }, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// Public config read (auth required, any user)
apiRouter.get("/config", authenticate, async (_req, res, next) => {
  try {
    const [rows]: any = await pool.execute(
      `SELECT config_key, config_value FROM app_config`,
    );
    const map: Record<string, string> = {};
    rows.forEach((r: any) => {
      map[r.config_key] = r.config_value;
    });
    res.json({ success: true, data: map, error: null });
  } catch (e) {
    next(e);
  }
});

// Accept terms (female only)
apiRouter.post(
  "/users/me/accept-terms",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.gender !== "female") {
        throw new AppError(403, "FORBIDDEN", "Only companions.");
      }
      await pool.execute(
        `UPDATE users SET terms_accepted_at = NOW(3) WHERE id = ? AND terms_accepted_at IS NULL`,
        [req.user!.id],
      );
      res.json({ success: true, data: { ok: true }, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// Acknowledge channels (WhatsApp mandatory)
apiRouter.post(
  "/users/me/acknowledge-channels",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.gender !== "female") {
        throw new AppError(403, "FORBIDDEN", "Only companions.");
      }
      const { whatsapp, youtube, instagram } = req.body;
      if (!whatsapp || !youtube || !instagram) {
        throw new AppError(
          400,
          "INCOMPLETE",
          "All channels must be acknowledged.",
        );
      }
      await pool.execute(
        `UPDATE users SET channels_acknowledged_at = NOW(3) WHERE id = ? AND channels_acknowledged_at IS NULL`,
        [req.user!.id],
      );
      res.json({ success: true, data: { ok: true }, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// Admin — read all config
apiRouter.get("/admin/config", requireAdmin, async (_req, res, next) => {
  try {
    const [rows]: any = await pool.execute(
      `SELECT config_key, config_value, updated_at FROM app_config`,
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    next(e);
  }
});

// Admin — update one config key
apiRouter.patch("/admin/config/:key", requireAdmin, async (req, res, next) => {
  try {
    const key = req.params.key;
    const value = String(req.body.value ?? "");
    await pool.execute(
      `INSERT INTO app_config (config_key, config_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
      [key, value],
    );
    res.json({ success: true, data: { key, value }, error: null });
  } catch (e) {
    next(e);
  }
});

apiRouter.patch(
  "/admin/users/:id/category",
  requireAdmin,
  async (req, res, next) => {
    try {
      const userId = parseInt(req.params.id, 10);
      const { categoryTag } = req.body;
      const allowed = [
        "star",
        "relationship",
        "marriage",
        "confidence",
        "friendly",
        null,
      ];
      if (!allowed.includes(categoryTag)) {
        throw new AppError(400, "INVALID_CATEGORY", "Invalid category.");
      }
      await pool.execute(`UPDATE users SET category_tag = ? WHERE id = ?`, [
        categoryTag,
        userId,
      ]);
      res.json({ success: true, data: { userId, categoryTag }, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/users/me/notifications/clear",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      await pool.execute(
        `DELETE FROM user_notifications WHERE recipient_id = ?`,
        [req.user!.id],
      );
      res.json({ success: true, data: { ok: true }, error: null });
    } catch (e) {
      next(e);
    }
  },
);
// ── Phone change: step 1 — request OTP on new number ──────────────
apiRouter.post(
  "/users/me/phone/request",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { newPhone } = req.body;
      if (!newPhone || !/^\+[1-9]\d{7,14}$/.test(newPhone)) {
        throw new AppError(
          400,
          "INVALID_PHONE",
          "Provide a valid E.164 phone number.",
        );
      }

      // Make sure the new number isn't already taken
      const existing = await UserModel.findByPhone(newPhone);
      if (existing && existing.id !== req.user!.id) {
        throw new AppError(
          409,
          "PHONE_TAKEN",
          "This phone number is already registered to another account.",
        );
      }

      // Reuse the OTP service — send OTP to the new number
      const result = await AuthService.sendOtp(newPhone);

      res.json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// ── Phone change: step 2 — verify OTP and swap the number ─────────
apiRouter.post(
  "/users/me/phone/verify",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const { newPhone, otp } = req.body;
      if (!newPhone || !otp || otp.length !== 6) {
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Phone and 6-digit OTP are required.",
        );
      }

      // Look up the OTP issued for the new phone
      const record = await AuthModel.findValidOtp(newPhone);
      if (!record) {
        throw new AppError(
          400,
          "OTP_EXPIRED_OR_INVALID",
          "No active OTP found for this number.",
        );
      }
      if (record.attempts >= 5) {
        throw new AppError(
          429,
          "TOO_MANY_ATTEMPTS",
          "Maximum verification attempts exceeded.",
        );
      }

      const computedHash = CryptoUtil.sha256(otp);
      if (computedHash !== record.code_hash) {
        await AuthModel.incrementOtpAttempts(record.id);
        throw new AppError(400, "INVALID_OTP", "Incorrect OTP.");
      }
      await AuthModel.consumeOtp(record.id);

      // Re-verify the number isn't taken (race between request and verify)
      const existing = await UserModel.findByPhone(newPhone);
      if (existing && existing.id !== req.user!.id) {
        throw new AppError(
          409,
          "PHONE_TAKEN",
          "This phone number is already registered.",
        );
      }

      // Update the phone on our user row
      await conn.execute(
        `UPDATE users SET phone = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [newPhone, req.user!.id],
      );

      // Revoke all refresh tokens — user must re-login with new phone
      await conn.execute(
        `UPDATE auth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3)
         WHERE user_id = ? AND revoked_at IS NULL`,
        [req.user!.id],
      );

      await conn.commit();

      res.json({
        success: true,
        data: { phone: newPhone, forceLogout: true },
        error: null,
      });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  },
);

apiRouter.post(
  "/users/me/delete",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const { reason, confirmText } = req.body;

      // Require the user to type "DELETE" to confirm
      if (confirmText !== "DELETE") {
        throw new AppError(
          400,
          "CONFIRMATION_REQUIRED",
          'Type "DELETE" to confirm account deletion.',
        );
      }

      const userId = req.user!.id;

      // Soft-delete: set deleted_at, suspend the account, revoke tokens
      await conn.execute(
        `UPDATE users
           SET deleted_at = CURRENT_TIMESTAMP(3),
               account_state = 'deactivated',
               is_online = FALSE,
               suspension_reason = ?,
               updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [
          reason
            ? `Self-deleted: ${String(reason).slice(0, 200)}`
            : "Self-deleted",
          userId,
        ],
      );

      // Revoke all refresh tokens — force logout everywhere
      await conn.execute(
        `UPDATE auth_refresh_tokens
           SET revoked_at = CURRENT_TIMESTAMP(3)
         WHERE user_id = ? AND revoked_at IS NULL`,
        [userId],
      );

      // Cancel any pending withdrawal (do NOT refund; policy decision)
      await conn.execute(
        `UPDATE withdrawals
           SET status = 'rejected',
               processed_at = CURRENT_TIMESTAMP(3),
               admin_note = 'Auto-cancelled: user deleted account'
         WHERE user_id = ? AND status = 'pending'`,
        [userId],
      );

      // Audit log if admin table exists and we can find an admin id for the system
      // (Skipped here — deleted_at column on users is sufficient)

      await conn.commit();

      res.json({
        success: true,
        data: { deleted: true },
        error: null,
      });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  },
);

// ── Female: notify last 20 males she called that she is online ────
apiRouter.post(
  "/users/me/notify-online",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const me = req.user!;
      if (me.gender !== "female") {
        throw new AppError(403, "FORBIDDEN", "Only companions can notify.");
      }

      // Rate limit: once per 5 minutes
      const [recentRows]: any = await pool.execute(
        `SELECT id FROM user_notifications
          WHERE sender_id = ?
            AND created_at > DATE_SUB(NOW(3), INTERVAL 5 MINUTE)
          LIMIT 1`,
        [me.id],
      );
      if (recentRows.length > 0) {
        throw new AppError(
          429,
          "RATE_LIMITED",
          "You can notify once every 5 minutes.",
        );
      }

      // Last 20 unique males she has had a call with
      const [recipients]: any = await pool.execute(
        `SELECT DISTINCT male_id FROM (
           SELECT CASE WHEN caller_id = ? THEN receiver_id ELSE caller_id END AS male_id
             FROM calls_history
            WHERE (caller_id = ? OR receiver_id = ?)
              AND (caller_id = ? OR receiver_id = ?)
            ORDER BY start_time DESC
            LIMIT 20
         ) AS t
         JOIN users u ON u.id = t.male_id
         WHERE u.gender = 'male' AND u.deleted_at IS NULL`,
        [me.id, me.id, me.id, me.id, me.id],
      );

      if (recipients.length === 0) {
        return res.json({
          success: true,
          data: { sent: 0 },
          error: null,
        });
      }

      const message = "I'm online now";
      const values = recipients.map((r: any) => [r.male_id, me.id, message]);

      await pool.query(
        `INSERT INTO user_notifications (recipient_id, sender_id, type, message)
         VALUES ?`,
        [values.map((v: any) => [v[0], v[1], "female_online", v[2]])],
      );

      // Socket push to each recipient
      const { emitToUser } = await import("../socket/socket.server.js");
      for (const r of recipients) {
        emitToUser(r.male_id, "notification:new", {
          type: "female_online",
          message,
          senderId: me.id,
        });
      }

      res.json({
        success: true,
        data: { sent: recipients.length },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── Male: list my notifications ───────────────────────────────────
apiRouter.get(
  "/users/me/notifications",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const limit = Math.min(
        parseInt(req.query.limit as string, 10) || 30,
        100,
      );
      const [rows]: any = await pool.execute(
        `SELECT n.id, n.type, n.message, n.read_at, n.created_at,
                n.sender_id,
                u.public_id AS sender_public_id,
                u.nickname AS sender_nickname,
                u.avatar_url AS sender_avatar,
                u.is_online AS sender_online
           FROM user_notifications n
           JOIN users u ON u.id = n.sender_id
          WHERE n.recipient_id = ?
          ORDER BY n.created_at DESC
          LIMIT ?`,
        [req.user!.id, limit.toString()],
      );

      res.json({
        success: true,
        data: { notifications: rows },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── Male: mark all notifications read ─────────────────────────────
apiRouter.post(
  "/users/me/notifications/read",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      await pool.execute(
        `UPDATE user_notifications
            SET read_at = NOW(3)
          WHERE recipient_id = ? AND read_at IS NULL`,
        [req.user!.id],
      );
      res.json({ success: true, data: { ok: true }, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/users/me/notifications/clear",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      await pool.execute(
        `DELETE FROM user_notifications WHERE recipient_id = ?`,
        [req.user!.id],
      );
      res.json({ success: true, data: { ok: true }, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// ============================================================================
// 3. DISCOVERY & PRESENCE
// ============================================================================
apiRouter.get("/users/discover", authenticate, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const search = ((req.query.search as string) || "").trim();
    const language = ((req.query.language as string) || "").trim();
    const category = ((req.query.category as string) || "all").trim();

    const conditions: string[] = [
      "gender = 'female'",
      "is_online = TRUE",
      "verification_status = 'approved'",
      "account_state = 'active'",
      "deleted_at IS NULL",
    ];
    const params: any[] = [];

    if (search) {
      // Normalize: strip "CX" prefix, strip leading zeros → match against numeric part
      const cleaned = search
        .toUpperCase()
        .replace(/^CX/, "")
        .replace(/^0+/, "");
      const numeric = /^\d+$/.test(cleaned) ? cleaned : null;

      if (numeric !== null) {
        // "1" → matches CX000001, "13" → matches CX000013
        conditions.push(
          "(CAST(SUBSTRING(public_id, 3) AS UNSIGNED) = ? OR nickname LIKE ?)",
        );
        params.push(parseInt(numeric, 10), `%${search}%`);
      } else {
        // Text search — nickname substring OR public_id starts with
        conditions.push("(public_id LIKE ? OR nickname LIKE ?)");
        params.push(`${search.toUpperCase()}%`, `%${search}%`);
      }
    }

    if (language) {
      conditions.push("primary_language = ?");
      params.push(language);
    }

    if (category && category !== "all") {
      conditions.push("category_tag = ?");
      params.push(category);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows]: any = await pool.execute(
      `SELECT id, uuid, public_id, nickname, avatar_url, primary_language,
              category_tag, is_online, last_seen_at
       FROM users
       ${whereClause}
       ORDER BY last_seen_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit.toString(), offset.toString()],
    );

    const [countRows]: any = await pool.execute(
      `SELECT COUNT(*) AS total FROM users ${whereClause}`,
      params,
    );

    res.json({
      success: true,
      data: {
        females: rows,
        total: countRows[0]?.total ?? 0,
        limit,
        offset,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
});

apiRouter.post(
  "/users/presence",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      await UserModel.updateOnlineStatus(
        pool,
        req.user!.id,
        Boolean(req.body.isOnline),
      );
      res.json({
        success: true,
        data: { isOnline: req.body.isOnline },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.patch(
  "/users/status/online",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { isOnline } = req.body;
      if (typeof isOnline !== "boolean") {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: "INVALID_PARAM",
            message: "isOnline must be a boolean (true or false).",
          },
        });
      }

      const result = await UsersService.toggleOnlineStatus(
        req.user!.id,
        isOnline,
      );
      res.json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// ============================================================================
// 4. CALL ORCHESTRATION (ZEGOCLOUD)
// ============================================================================
apiRouter.post(
  "/calls/initiate",
  authenticate,
  callInitiationRateLimiter,
  validateRequest({ body: InitiateCallSchema }),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const call = await CallsService.initiateCall(
        req.user!.id,
        req.body.receiverUuid,
      );
      res.status(201).json({ success: true, data: call, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.get(
  "/calls/incoming",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const data = await CallsService.getIncomingCall(req.user!.id);
      res.json({ success: true, data, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.get(
  "/calls/history",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const limit = Math.min(
        parseInt(req.query.limit as string, 10) || 20,
        100,
      );
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const userId = req.user!.id;
      const direction = (req.query.direction as string) || "all";
      const search = ((req.query.search as string) || "").trim();

      // Build WHERE clause
      const conditions: string[] = ["(ch.caller_id = ? OR ch.receiver_id = ?)"];
      const params: any[] = [userId, userId];

      if (direction === "outgoing") {
        conditions.push("ch.caller_id = ?");
        params.push(userId);
      } else if (direction === "incoming") {
        conditions.push("ch.receiver_id = ?");
        params.push(userId);
      } else if (direction === "missed") {
        // Missed = the receiver never answered AND caller is someone else
        conditions.push("ch.receiver_id = ?");
        conditions.push("ch.duration_seconds = 0");
        params.push(userId);
      } else if (direction === "starred") {
        // Starred = user rated 4 or 5 stars
        conditions.push("rr.rating >= 4");
      }

      if (search) {
        conditions.push("(u_c.nickname LIKE ? OR u_r.nickname LIKE ?)");
        const term = `%${search}%`;
        params.push(term, term);
      }

      const whereClause = `WHERE ${conditions.join(" AND ")}`;

      // Fetch page
      const [rows]: any = await pool.execute(
        `SELECT 
           ch.id, ch.uuid, ch.caller_id, ch.receiver_id,
           ch.start_time, ch.end_time,
           ch.duration_seconds, ch.billed_minutes,
           ch.amount_deducted, ch.amount_earned,
           ch.status,
           u_c.nickname AS caller_nickname,
           u_c.avatar_url AS caller_avatar,
           u_r.nickname AS receiver_nickname,
           u_r.avatar_url AS receiver_avatar,
           rr.rating AS my_rating,
           rr.id AS my_rating_id
         FROM calls_history ch
         LEFT JOIN users u_c ON ch.caller_id = u_c.id
         LEFT JOIN users u_r ON ch.receiver_id = u_r.id
         LEFT JOIN ratings_reviews rr 
           ON rr.call_id = ch.id AND rr.rater_id = ?
         ${whereClause}
         ORDER BY ch.start_time DESC
         LIMIT ? OFFSET ?`,
        [userId, ...params, limit.toString(), offset.toString()],
      );

      const [countRows]: any = await pool.execute(
        `SELECT COUNT(*) AS total 
         FROM calls_history ch
         LEFT JOIN users u_c ON ch.caller_id = u_c.id
         LEFT JOIN users u_r ON ch.receiver_id = u_r.id
         ${whereClause}`,
        params,
      );

      const calls = rows.map((r: any) => {
        const isOutgoing = r.caller_id === userId;
        const peerNickname = isOutgoing
          ? r.receiver_nickname
          : r.caller_nickname;
        const peerAvatar = isOutgoing ? r.receiver_avatar : r.caller_avatar;
        const peerId = isOutgoing ? r.receiver_id : r.caller_id;

        return {
          id: r.id,
          uuid: r.uuid,
          direction: isOutgoing ? "outgoing" : "incoming",
          peerId,
          peerNickname: peerNickname ?? "Unknown",
          peerAvatar,
          startTime: r.start_time,
          endTime: r.end_time,
          durationSeconds: r.duration_seconds,
          billedMinutes: r.billed_minutes,
          amount: isOutgoing ? r.amount_deducted : r.amount_earned,
          status: r.status,
          myRating: r.my_rating,
          myRatingId: r.my_rating_id,
        };
      });

      const total = Number(countRows[0]?.total ?? 0);

      res.json({
        success: true,
        data: {
          calls,
          total,
          limit,
          offset,
          hasMore: offset + calls.length < total,
        },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/calls/:uuid/token",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const data = await CallsService.getRoomToken(
        req.user!.id,
        req.params.uuid,
      );
      res.json({ success: true, data, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/calls/:uuid/accept",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const result = await CallsService.acceptCall(
        req.user!.id,
        req.params.uuid,
      );
      res.json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/calls/:uuid/end",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const result = await CallsService.endCall(
        req.params.uuid,
        req.body.reason || "user_ended",
      );
      res.json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/calls/random",
  authenticate,
  callInitiationRateLimiter,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const call = await CallsService.initiateRandomCall(req.user!.id);
      res.status(201).json({ success: true, data: call, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/calls/:uuid/reject",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const result = await CallsService.rejectCall(
        req.user!.id,
        req.params.uuid,
      );
      res.json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.get(
  "/calls/:uuid",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const data = await CallsService.getCallStatus(
        req.user!.id,
        req.params.uuid,
      );
      res.json({ success: true, data, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.get("/admin/calls", requireAdmin, async (req, res, next) => {
  try {
    const search = req.query.search as string;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const data = await CallModel.listAdminCalls({ search, limit, offset });
    res.json({ success: true, data, error: null });
  } catch (e) {
    next(e);
  }
});

// ============================================================================
// 5. POST-CALL QUALITY & RATINGS
// ============================================================================
apiRouter.get(
  "/ratings/pending",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const pending = await RatingModel.getPendingRatingForCaller(req.user!.id);
      res.json({ success: true, data: pending, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/ratings/submit",
  authenticate,
  validateRequest({ body: SubmitRatingSchema }),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { callId, rating, review } = req.body;
      const result = await RatingsService.submitRating(
        req.user!.id,
        callId,
        rating,
        review,
      );
      res.status(201).json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// ============================================================================
// 6. RECHARGES (PAYU) & WALLET
// ============================================================================
apiRouter.post(
  "/recharges/initiate",
  authenticate,
  financialRateLimiter,
  idempotency("recharge"),
  validateRequest({ body: InitiateRechargeSchema }),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { amount, idempotencyKey } = req.body;
      const checkout = await RechargesService.initiateRecharge(
        req.user!.id,
        amount,
        idempotencyKey,
      );
      res.status(201).json({ success: true, data: checkout, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post("/recharges/payu/callback", async (req, res) => {
  console.log("════════════════════════════════════════");
  console.log("[payu-callback] RECEIVED at", new Date().toISOString());
  console.log("[payu-callback] content-type:", req.headers["content-type"]);
  console.log("[payu-callback] body:", JSON.stringify(req.body, null, 2));
  console.log("════════════════════════════════════════");

  try {
    await RechargesService.processCallback(req.body);
    console.log("[payu-callback] ✅ processCallback SUCCESS");
  } catch (e: any) {
    console.log("[payu-callback] ❌ ERROR:", e.message);
    console.log("[payu-callback] stack:", e.stack);
    // Don't `next(e)` — we still want to return a closable page to the WebView
  }

  // Return HTML that signals the WebView to close.
  // Plain text breaks iOS/Android WebViews sometimes; HTML is safer.
  res.status(200).send(`
    <!doctype html>
    <html>
      <head><meta charset="utf-8"/><title>Payment</title></head>
      <body>
        <p>CALLBACK_PROCESSED_SUCCESSFULLY</p>
        <script>
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage('CALLBACK_PROCESSED_SUCCESSFULLY');
          }
        </script>
      </body>
    </html>
  `);
});

apiRouter.get(
  "/wallet/history",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const txs = await WalletModel.getUserTransactions(
        req.user!.id,
        parseInt(req.query.limit as string) || 20,
        parseInt(req.query.offset as string) || 0,
      );
      res.json({ success: true, data: txs, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.get(
  "/wallet/balance",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const [rows]: any = await pool.execute(
        `SELECT wallet_balance FROM users WHERE id = ? AND deleted_at IS NULL`,
        [req.user!.id],
      );
      if (!rows.length) {
        throw new AppError(404, "USER_NOT_FOUND", "User not found.");
      }
      res.json({
        success: true,
        data: { balance: rows[0].wallet_balance },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

// GET /api/v1/admin/recharges - List orders with pagination & filters
apiRouter.get("/admin/recharges", requireAdmin, async (req, res, next) => {
  try {
    const status = req.query.status as string;
    const search = req.query.search as string;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const data = await RechargeModel.listOrders({
      status,
      search,
      limit,
      offset,
    });
    res.json({ success: true, data, error: null });
  } catch (e) {
    next(e);
  }
});

apiRouter.post(
  "/admin/recharges/:id/reconcile",
  requireAdmin,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const rechargeId = parseInt(req.params.id, 10);
      const { note } = req.body;

      if (!note || !note.trim()) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: "NOTE_REQUIRED",
            message: "Audit justification note is required.",
          },
        });
      }

      const result = await RechargesService.manualReconcile(
        req.user!.id,
        rechargeId,
        note.trim(),
      );
      res.json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// ============================================================================
// 7. WITHDRAWALS (COMPANION PAYOUTS)
// ============================================================================
apiRouter.post(
  "/withdrawals/request",
  authenticate,
  financialRateLimiter,
  idempotency("withdrawal"),
  validateRequest({ body: RequestWithdrawalSchema }),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { amount, upiId, idempotencyKey } = req.body;
      const result = await WithdrawalsService.requestWithdrawal(
        req.user!.id,
        amount,
        upiId,
        idempotencyKey,
      );
      res.status(201).json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.get(
  "/withdrawals/history",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const userId = req.user!.id;

      const [rows]: any = await pool.execute(
        `SELECT 
           w.id, w.uuid, w.requested_amount, w.tax_amount, w.net_amount,
           w.payout_method, w.payout_upi_id,
           w.status, w.processed_at, w.admin_note,
           w.created_at
         FROM withdrawals w
         WHERE w.user_id = ?
         ORDER BY w.created_at DESC
         LIMIT ? OFFSET ?`,
        [userId, limit.toString(), offset.toString()],
      );

      const [countRows]: any = await pool.execute(
        `SELECT COUNT(*) AS total FROM withdrawals WHERE user_id = ?`,
        [userId],
      );

      res.json({
        success: true,
        data: {
          withdrawals: rows.map((r: any) => ({
            id: r.id,
            uuid: r.uuid,
            requestedAmount: r.requested_amount,
            taxAmount: r.tax_amount,
            netAmount: r.net_amount,
            payoutMethod: r.payout_method,
            payoutUpiId: r.payout_upi_id,
            status: r.status,
            processedAt: r.processed_at,
            adminNote: r.admin_note,
            createdAt: r.created_at,
          })),
          total: countRows[0]?.total ?? 0,
        },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/verifications/upload",
  authenticate,
  uploadVoice,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!req.file) {
        throw new AppError(
          400,
          "NO_FILE",
          "No audio file received under field 'voice'.",
        );
      }

      // Publicly reachable URL — see env note below
      const publicBase =
        process.env.PUBLIC_BASE_URL ||
        `http://localhost:${process.env.PORT || 5000}`;
      const voiceUrl = `${publicBase}/uploads/recordings/${req.file.filename}`;

      res.status(201).json({
        success: true,
        data: {
          voiceUrl,
          sizeBytes: req.file.size,
          mime: req.file.mimetype,
        },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ============================================================================
// 8. AUDIO VERIFICATION (KYC)
// ============================================================================
apiRouter.post(
  "/verifications/submit",
  authenticate,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const result = await VerificationService.submitVoice(
        req.user!.id,
        req.body,
      );
      res.status(201).json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// ============================================================================
// 9. ADMIN SECURE CONSOLE
// ============================================================================
apiRouter.get(
  "/admin/verifications/pending",
  requireAdmin,
  async (req, res, next) => {
    try {
      const data = await VerificationModel.getPending();
      res.json({ success: true, data, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/admin/verifications/:id/review",
  requireAdmin,
  validateRequest({ body: AdminReviewVerificationSchema }),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { action, reasonCode, reasonNote } = req.body;
      const result = await VerificationService.reviewSubmission(
        req.user!.id,
        parseInt(req.params.id),
        action,
        reasonCode,
        reasonNote,
      );
      res.json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.get(
  "/admin/withdrawals/pending",
  requireAdmin,
  async (req, res, next) => {
    try {
      const data = await WithdrawalModel.getPending();
      res.json({ success: true, data, error: null });
    } catch (e) {
      next(e);
    }
  },
);

apiRouter.post(
  "/admin/withdrawals/:id/settle",
  requireAdmin,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { action, note } = req.body;
      const result = await WithdrawalsService.settleWithdrawal(
        req.user!.id,
        parseInt(req.params.id),
        action,
        note,
      );
      res.json({ success: true, data: result, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// GET /api/v1/admin/ratings/flagged
apiRouter.get(
  "/admin/ratings/flagged",
  requireAdmin,
  async (req, res, next) => {
    try {
      const [rows]: any = await pool.execute(
        `SELECT 
         rr.id,
         rr.call_id,
         rr.rating,
         rr.review AS comment,
         rr.flagged_reason,
         rr.is_flagged,
         rr.created_at,
         rr.rater_id,
         rater.nickname AS caller_name,
         rater.phone AS caller_phone,
         rr.ratee_id,
         ratee.nickname AS companion_name,
         ratee.phone AS companion_phone
       FROM ratings_reviews rr
       LEFT JOIN users rater ON rr.rater_id = rater.id
       LEFT JOIN users ratee ON rr.ratee_id = ratee.id
       WHERE rr.rating <= 2 OR rr.is_flagged = 1
       ORDER BY rr.created_at DESC`,
      );

      res.json({ success: true, data: rows, error: null });
    } catch (e) {
      next(e);
    }
  },
);

// GET /api/v1/admin/ledger - List all double-entry ledger movements
// GET /api/v1/admin/ledger
apiRouter.get("/admin/ledger", requireAdmin, async (req, res, next) => {
  try {
    const type = req.query.type as string;
    const search = req.query.search as string;
    const limit = parseInt(req.query.limit as string, 10) || 25;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const conditions: string[] = [];
    const queryParams: any[] = [];

    if (type && type !== "all") {
      conditions.push("wt.type = ?");
      queryParams.push(type);
    }

    if (search && search.trim()) {
      conditions.push(
        "(wt.uuid LIKE ? OR u.phone LIKE ? OR u.nickname LIKE ?)",
      );
      const term = `%${search.trim()}%`;
      queryParams.push(term, term, term);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows]: any = await pool.execute(
      `SELECT 
         wt.id,
         wt.uuid,
         wt.user_id,
         wt.type,
         wt.direction,
         wt.amount,
         wt.balance_before,
         wt.balance_after,
         wt.reference_type,
         wt.reference_id,
         wt.metadata,
         wt.created_at,
         u.nickname AS user_nickname,
         u.phone AS user_phone
       FROM wallet_transactions wt
       LEFT JOIN users u ON wt.user_id = u.id
       ${whereClause}
       ORDER BY wt.created_at DESC
       LIMIT ? OFFSET ?`,
      [...queryParams, limit.toString(), offset.toString()],
    );

    const [countRows]: any = await pool.execute(
      `SELECT COUNT(*) as total 
       FROM wallet_transactions wt
       LEFT JOIN users u ON wt.user_id = u.id
       ${whereClause}`,
      queryParams,
    );

    res.json({
      success: true,
      data: {
        transactions: rows,
        total: countRows[0]?.total || 0,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/admin/ledger/adjust - Manual compensatory balance adjustment
apiRouter.post(
  "/admin/ledger/adjust",
  requireAdmin,
  async (req: AuthenticatedRequest, res, next) => {
    const conn = await pool.getConnection();
    try {
      const { userId, amount, direction, reason } = req.body;

      if (!userId || !amount || !direction || !reason?.trim()) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: "All adjustment parameters and reason are required.",
          },
        });
      }

      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: "INVALID_AMOUNT",
            message: "Amount must be a positive number.",
          },
        });
      }

      await conn.beginTransaction();

      const mutationType =
        direction === "credit" ? "manual_credit" : "manual_debit";
      const adjustmentUuid = uuidv4();

      await WalletService.mutateBalance(conn, {
        userId: parseInt(userId, 10),
        type: mutationType as any,
        direction,
        amount: numericAmount,
        referenceType: "admin_adjustment",
        referenceId: req.user!.id,
        idempotencyKey: `adj:${adjustmentUuid}`,
        metadata: {
          adjusted_by_admin: req.user!.id,
          reason: reason.trim(),
        },
      });

      await conn.execute(
        `INSERT INTO admin_audit_logs 
         (admin_id, action, target_type, target_id, details)
         VALUES (?, 'WALLET_MANUAL_ADJUSTMENT', 'user', ?, ?)`,
        [
          req.user!.id,
          userId,
          JSON.stringify({
            amount: numericAmount,
            direction,
            reason: reason.trim(),
            uuid: adjustmentUuid,
          }),
        ],
      );

      await conn.commit();
      res.json({
        success: true,
        data: { status: "applied", uuid: adjustmentUuid },
        error: null,
      });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  },
);

// GET /api/v1/admin/promotions - List promotion campaigns & usage metrics
apiRouter.get("/admin/promotions", requireAdmin, async (req, res, next) => {
  try {
    const [promotions]: any = await pool.execute(
      `SELECT 
           p.*,
           (SELECT COUNT(*) FROM user_promotions up WHERE up.promotion_id = p.id) as claim_count,
           (SELECT IFNULL(SUM(up.claimed_amount), 0) FROM user_promotions up WHERE up.promotion_id = p.id) as total_disbursed
         FROM promotions p
         ORDER BY p.created_at DESC`,
    );

    res.json({ success: true, data: promotions, error: null });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/v1/admin/promotions/:id/status - Toggle promo active status
apiRouter.patch(
  "/admin/promotions/:id/status",
  requireAdmin,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const promoId = parseInt(req.params.id, 10);
      const { isActive } = req.body;

      await pool.execute(
        `UPDATE promotions SET is_active = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [isActive ? 1 : 0, promoId],
      );

      await pool.execute(
        `INSERT INTO admin_audit_logs 
         (admin_id, action, target_type, target_id, details)
         VALUES (?, 'PROMOTION_STATUS_TOGGLE', 'promotion', ?, ?)`,
        [
          req.user!.id,
          promoId,
          JSON.stringify({ isActive: Boolean(isActive) }),
        ],
      );

      res.json({
        success: true,
        data: { id: promoId, isActive: Boolean(isActive) },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

// GET /api/v1/admin/audit-logs
apiRouter.get("/admin/audit-logs", requireAdmin, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const [rows]: any = await pool.execute(
      `SELECT 
         aal.id,
         aal.admin_id,
         aal.action,
         aal.entity_type AS target_type,
         aal.entity_id AS target_id,
         COALESCE(JSON_UNQUOTE(aal.after_state), JSON_UNQUOTE(aal.before_state), '') AS details,
         aal.ip_address,
         aal.created_at,
         adm.email AS admin_email
       FROM admin_audit_logs aal
       LEFT JOIN admins adm ON aal.admin_id = adm.id
       ORDER BY aal.created_at DESC
       LIMIT ? OFFSET ?`,
      [limit.toString(), offset.toString()],
    );

    const [countRows]: any = await pool.execute(
      `SELECT COUNT(*) as total FROM admin_audit_logs`,
    );

    res.json({
      success: true,
      data: {
        logs: rows,
        total: countRows[0]?.total || 0,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/admin/dashboard/overview
apiRouter.get(
  "/admin/dashboard/overview",
  requireAdmin,
  async (req, res, next) => {
    try {
      const [userRows]: any = await pool.execute(
        `SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL`,
      );
      const [callRows]: any = await pool.execute(
        `SELECT COUNT(*) as count FROM call_sessions WHERE status IN ('initiated', 'ringing', 'accepted')`,
      );
      const [kycRows]: any = await pool.execute(
        `SELECT COUNT(*) as count FROM verification_submissions WHERE status = 'pending'`,
      );
      const [withdrawRows]: any = await pool.execute(
        `SELECT COUNT(*) as count, COALESCE(SUM(requested_amount), 0) as total FROM withdrawals WHERE status = 'pending'`,
      );
      const [marginRows]: any = await pool.execute(
        `SELECT COALESCE(SUM(platform_margin), 0) as total FROM calls_history`,
      );
      const [rechargeRows]: any = await pool.execute(
        `SELECT COALESCE(SUM(base_amount), 0) as total FROM recharges WHERE status = 'success'`,
      );

      res.json({
        success: true,
        data: {
          totalUsers: Number(userRows[0]?.count || 0),
          activeLiveCalls: Number(callRows[0]?.count || 0),
          pendingKycCount: Number(kycRows[0]?.count || 0),
          pendingWithdrawalCount: Number(withdrawRows[0]?.count || 0),
          pendingWithdrawalAmount: String(withdrawRows[0]?.total || "0.00"),
          totalPlatformMargin: String(marginRows[0]?.total || "0.00"),
          totalGrossRecharged: String(rechargeRows[0]?.total || "0.00"),
        },
        error: null,
      });
    } catch (e) {
      next(e);
    }
  },
);

// GET /api/v1/admin/users - Comprehensive directory of all registered users
apiRouter.get("/admin/users", requireAdmin, async (req, res, next) => {
  try {
    const search = req.query.search as string;
    const gender = req.query.gender as string;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const conditions: string[] = ["deleted_at IS NULL"];
    const queryParams: any[] = [];

    if (gender && gender !== "all") {
      conditions.push("gender = ?");
      queryParams.push(gender);
    }

    if (search && search.trim()) {
      conditions.push("(phone LIKE ? OR nickname LIKE ? OR uuid LIKE ?)");
      const term = `%${search.trim()}%`;
      queryParams.push(term, term, term);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows]: any = await pool.execute(
      `SELECT 
         id, uuid, phone, nickname, real_name, gender, birth_year, primary_language,
         verification_status AS onboarding_status,
         CASE WHEN account_state = 'suspended' THEN 1 ELSE 0 END AS is_suspended,
         suspension_reason, is_online, wallet_balance AS wallet_balance_inr,
         created_at, updated_at
       FROM users
       ${whereClause}
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
      [...queryParams, limit.toString(), offset.toString()],
    );

    res.json({
      success: true,
      data: rows,
      error: null,
    });
  } catch (e) {
    next(e);
  }
});

apiRouter.delete(
  "/admin/users/:id/hard-delete",
  requireAdmin,
  async (req: AuthenticatedRequest, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const userId = parseInt(req.params.id, 10);
      if (!Number.isFinite(userId)) {
        throw new AppError(400, "INVALID_ID", "Invalid user id.");
      }

      const [userRows]: any = await conn.execute(
        `SELECT id, phone, uuid FROM users WHERE id = ?`,
        [userId],
      );
      if (!userRows.length) {
        throw new AppError(404, "USER_NOT_FOUND", "User not found.");
      }

      // Ledger rows are historically significant — reassign to sentinel
      // user id 1 (system) so financial audit is preserved.
      const SENTINEL_USER_ID = 1;

      // 1. Reassign wallet_transactions to sentinel
      await conn.execute(
        `UPDATE wallet_transactions SET user_id = ? WHERE user_id = ?`,
        [SENTINEL_USER_ID, userId],
      );

      // 2. Null out user references in calls_history (keep the row)
      await conn.execute(
        `UPDATE calls_history SET caller_id = ? WHERE caller_id = ?`,
        [SENTINEL_USER_ID, userId],
      );
      await conn.execute(
        `UPDATE calls_history SET receiver_id = ? WHERE receiver_id = ?`,
        [SENTINEL_USER_ID, userId],
      );

      // 3. Null out ratings_reviews references
      await conn.execute(
        `UPDATE ratings_reviews SET rater_id = ? WHERE rater_id = ?`,
        [SENTINEL_USER_ID, userId],
      );
      await conn.execute(
        `UPDATE ratings_reviews SET ratee_id = ? WHERE ratee_id = ?`,
        [SENTINEL_USER_ID, userId],
      );

      // 4. Cancel pending withdrawals for this user
      await conn.execute(
        `UPDATE withdrawals
            SET status = 'rejected',
                processed_at = NOW(3),
                admin_note = 'Auto-cancelled: account hard-deleted'
          WHERE user_id = ? AND status = 'pending'`,
        [userId],
      );
      // Reassign processed withdrawals to sentinel for audit
      await conn.execute(
        `UPDATE withdrawals SET user_id = ? WHERE user_id = ?`,
        [SENTINEL_USER_ID, userId],
      );

      // 5. Reassign recharges
      await conn.execute(`UPDATE recharges SET user_id = ? WHERE user_id = ?`, [
        SENTINEL_USER_ID,
        userId,
      ]);

      // 6. Reassign promotions grants (or delete — grants are historic, reassign)
      await conn.execute(
        `UPDATE wallet_promotion_grants SET user_id = ? WHERE user_id = ?`,
        [SENTINEL_USER_ID, userId],
      );

      // 7. Reassign notifications
      await conn.execute(
        `UPDATE user_notifications SET recipient_id = ? WHERE recipient_id = ?`,
        [SENTINEL_USER_ID, userId],
      );
      await conn.execute(
        `UPDATE user_notifications SET sender_id = ? WHERE sender_id = ?`,
        [SENTINEL_USER_ID, userId],
      );

      // 8. Delete call_sessions rows tied to the user
      await conn.execute(
        `DELETE FROM call_broadcast_targets
          WHERE receiver_id = ?
             OR session_id IN (SELECT id FROM call_sessions WHERE caller_id = ? OR receiver_id = ?)`,
        [userId, userId, userId],
      );
      await conn.execute(
        `DELETE FROM call_sessions WHERE caller_id = ? OR receiver_id = ?`,
        [userId, userId],
      );

      // 9. Delete verification submissions + devices + refresh tokens (cascades)
      //    These have ON DELETE CASCADE from users, so they're handled below.

      // 10. Delete the user (cascades to user_devices, auth_refresh_tokens,
      //     verification_submissions, user_languages, wallet_promotion_grants)
      await conn.execute(`DELETE FROM users WHERE id = ?`, [userId]);

      await conn.execute(
        `INSERT INTO admin_audit_logs 
           (admin_id, action, entity_type, entity_id, before_state, after_state)
         VALUES (?, 'USER_HARD_DELETE', 'user', ?, ?, ?)`,
        [
          req.user!.id,
          String(userId),
          JSON.stringify({ phone: userRows[0].phone, uuid: userRows[0].uuid }),
          JSON.stringify({ deleted: true }),
        ],
      );

      await conn.commit();
      res.json({ success: true, data: { deleted: true }, error: null });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  },
);
