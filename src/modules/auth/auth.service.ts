import crypto from "crypto";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import { pool } from "../../config/database.js";
import { env } from "../../config/env.js";
import { AuthModel } from "../../models/auth.model.js";
import { UserModel } from "../../models/user.model.js";
import { AdminModel } from "../../models/admin.model.js";
import { CryptoUtil } from "../../utils/crypto.util.js";
import { AppError } from "../../middleware/error.middleware.js";
import { SmsService } from "../../services/sms.service.js";

export class AuthService {
  public static async sendOtp(phone: string): Promise<{ debugOtp?: string }> {
    // const rawOtp = crypto.randomInt(100000, 999999).toString();
    const rawOtp = "123456";
    const codeHash = CryptoUtil.sha256(rawOtp);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await AuthModel.insertOtp(phone, codeHash);
    await SmsService.dispatchOtp(phone, rawOtp);
    console.log(rawOtp);
    return env.NODE_ENV !== "production" ? { debugOtp: rawOtp } : {};
  }

  /**
   * Verifies the OTP.
   *
   * Existing user → full session (access + refresh tokens).
   * New phone → issues a short-lived "onboarding" JWT. The actual user row
   * is created later via POST /users/onboarding/create with gender, nickname,
   * birthYear, avatarUrl, etc.
   */
  public static async verifyOtp(phone: string, otp: string, deviceId: string) {
    const record = await AuthModel.findValidOtp(phone);
    if (!record) {
      throw new AppError(400, "OTP_EXPIRED_OR_INVALID", "No active OTP found.");
    }
    if (record.attempts >= 5) {
      throw new AppError(429, "TOO_MANY_ATTEMPTS", "Max attempts exceeded.");
    }

    const computedHash = CryptoUtil.sha256(otp);
    if (computedHash !== record.code_hash) {
      await AuthModel.incrementOtpAttempts(record.id);
      throw new AppError(400, "INVALID_OTP", "Incorrect OTP.");
    }
    await AuthModel.consumeOtp(record.id);

    const user = await UserModel.findByPhone(phone);

    // ── New phone — issue onboarding token, do NOT create user yet ──
    if (!user) {
      const onboardingToken = jwt.sign(
        {
          typ: "onboarding",
          phone,
          deviceId,
        },
        env.JWT_ACCESS_SECRET,
        { expiresIn: "30m" },
      );

      return {
        onboardingRequired: true,
        onboardingToken,
        accessToken: null,
        refreshToken: null,
        user: null,
      };
    }

    if (user.account_state === "suspended" || user.account_state === "banned") {
      throw new AppError(
        403,
        "ACCOUNT_BLOCKED",
        `Account is currently ${user.account_state}.`,
      );
    }

    const familyId = uuidv4();
    const rawRefreshToken = crypto.randomBytes(40).toString("hex");
    const refreshHash = CryptoUtil.sha256(rawRefreshToken);
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await AuthModel.insertRefreshToken(pool, {
      userId: user.id,
      tokenHash: refreshHash,
      familyId,
      deviceId,
      expiresAt: refreshExpiresAt,
    });

    const accessToken = jwt.sign(
      {
        id: user.id,
        uuid: user.uuid,
        phone: user.phone,
        gender: user.gender,
        role: "user",
      },
      env.JWT_ACCESS_SECRET,
      { expiresIn: "15m" },
    );

    return {
      onboardingRequired: false,
      onboardingToken: null,
      accessToken,
      refreshToken: rawRefreshToken,
      user: {
        id: user.id,
        uuid: user.uuid,
        publicId: user.public_id,
        phone: user.phone,
        gender: user.gender,
        nickname: user.nickname,
        avatarUrl: user.avatar_url,
        verificationStatus: user.verification_status,
        walletBalance: user.wallet_balance,
        isOnline: Boolean(user.is_online),
        onboardingCompleted: Boolean(user.onboarding_completed_at),
        primaryLanguage: user.primary_language,
        birthYear: user.birth_year,
        termsAcceptedAt: user.terms_accepted_at,
        channelsAcknowledgedAt: user.channels_acknowledged_at,
      },
    };
  }

  /**
   * Creates the user row after the OTP was verified (onboarding token flow).
   * Called from POST /users/onboarding/create.
   */
  public static async completeSignup(
    onboardingToken: string,
    data: {
      gender: "male" | "female";
      nickname: string;
      birthYear?: number | null;
      avatarUrl?: string | null;
    },
  ) {
    let payload: any;
    try {
      payload = jwt.verify(onboardingToken, env.JWT_ACCESS_SECRET);
    } catch {
      throw new AppError(
        401,
        "ONBOARDING_TOKEN_INVALID",
        "Signup session expired. Please start over.",
      );
    }
    if (payload.typ !== "onboarding") {
      throw new AppError(
        401,
        "ONBOARDING_TOKEN_INVALID",
        "Invalid onboarding token.",
      );
    }

    const phone: string = payload.phone;
    const deviceId: string = payload.deviceId ?? "unknown";

    const existing = await UserModel.findByPhone(phone);
    if (existing) {
      throw new AppError(
        409,
        "USER_ALREADY_EXISTS",
        "This phone is already registered.",
      );
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const userUuid = uuidv4();
      const insertId = await UserModel.create(conn, {
        uuid: userUuid,
        phone,
        gender: data.gender,
        nickname: data.nickname,
        birthYear: data.birthYear ?? null,
        avatarUrl: data.avatarUrl ?? null,
      });

      await conn.commit();

      const user = await UserModel.findById(insertId);
      if (!user)
        throw new AppError(500, "USER_CREATE_FAILED", "Failed to create user.");

      const familyId = uuidv4();
      const rawRefreshToken = crypto.randomBytes(40).toString("hex");
      const refreshHash = CryptoUtil.sha256(rawRefreshToken);
      const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await AuthModel.insertRefreshToken(pool, {
        userId: user.id,
        tokenHash: refreshHash,
        familyId,
        deviceId,
        expiresAt: refreshExpiresAt,
      });

      const accessToken = jwt.sign(
        {
          id: user.id,
          uuid: user.uuid,
          phone: user.phone,
          gender: user.gender,
          role: "user",
        },
        env.JWT_ACCESS_SECRET,
        { expiresIn: "15m" },
      );

      return {
        accessToken,
        refreshToken: rawRefreshToken,
        user: {
          id: user.id,
          uuid: user.uuid,
          publicId: user.public_id,
          phone: user.phone,
          gender: user.gender,
          nickname: user.nickname,
          avatarUrl: user.avatar_url,
          verificationStatus: user.verification_status,
          walletBalance: user.wallet_balance,
          isOnline: Boolean(user.is_online),
          onboardingCompleted: Boolean(user.onboarding_completed_at),
          primaryLanguage: user.primary_language,
          birthYear: user.birth_year,
          termsAcceptedAt: user.terms_accepted_at,
          channelsAcknowledgedAt: user.channels_acknowledged_at,
        },
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  public static async refreshAccessToken(rawRefreshToken: string) {
    const tokenHash = CryptoUtil.sha256(rawRefreshToken);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const tokenRecord = await AuthModel.lockRefreshTokenByHash(
        conn,
        tokenHash,
      );
      if (!tokenRecord) {
        throw new AppError(
          401,
          "INVALID_REFRESH_TOKEN",
          "Refresh token not recognized.",
        );
      }
      if (tokenRecord.revoked_at !== null) {
        await AuthModel.revokeFamily(conn, tokenRecord.family_id);
        await conn.commit();
        throw new AppError(
          401,
          "TOKEN_REUSE_DETECTED",
          "Token replayed. Family revoked.",
        );
      }
      if (new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
        throw new AppError(401, "REFRESH_EXPIRED", "Refresh token expired.");
      }

      await AuthModel.revokeToken(conn, tokenRecord.id);

      const nextRawRefresh = crypto.randomBytes(40).toString("hex");
      const nextHash = CryptoUtil.sha256(nextRawRefresh);
      const nextExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await AuthModel.insertRefreshToken(conn, {
        userId: tokenRecord.user_id,
        tokenHash: nextHash,
        familyId: tokenRecord.family_id,
        deviceId: tokenRecord.device_id,
        expiresAt: nextExpiry,
      });

      const user = await UserModel.findById(tokenRecord.user_id);
      if (!user || user.account_state !== "active") {
        throw new AppError(403, "USER_INACTIVE", "User account unavailable.");
      }

      const accessToken = jwt.sign(
        {
          id: user.id,
          uuid: user.uuid,
          phone: user.phone,
          gender: user.gender,
          role: "user",
        },
        env.JWT_ACCESS_SECRET,
        { expiresIn: "15m" },
      );

      await conn.commit();
      return { accessToken, refreshToken: nextRawRefresh };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  public static async adminLogin(email: string, passwordPlain: string) {
    const admin = await AdminModel.findByEmail(email);
    if (!admin || !admin.is_active) {
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "Email or password incorrect.",
      );
    }
    const isValid = await bcrypt.compare(passwordPlain, admin.password_hash);
    if (!isValid) {
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "Email or password incorrect.",
      );
    }
    await AdminModel.updateLastLogin(admin.id);
    const accessToken = jwt.sign(
      { id: admin.id, uuid: admin.uuid, email: admin.email, role: "admin" },
      env.JWT_ACCESS_SECRET,
      { expiresIn: "4h" },
    );
    return {
      accessToken,
      admin: { uuid: admin.uuid, email: admin.email, role: admin.role },
    };
  }
}
