// src/modules/auth/auth.service.ts
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
    // 1. Generate cryptographically random 6-digit OTP
    const rawOtp = crypto.randomInt(100000, 999999).toString();
    const codeHash = CryptoUtil.sha256(rawOtp);

    // 2. Persist hashed OTP (expires_at is handled by MySQL DATE_ADD)
    await AuthModel.insertOtp(phone, codeHash);

    // 3. Dispatch the OTP via SMS gateway
    await SmsService.dispatchOtp(phone, rawOtp);

    // 4. Return debugOtp only in development/test environments
    return env.NODE_ENV !== "production" ? { debugOtp: rawOtp } : {};
  }

  /**
   * Validates submitted OTP against hashed database record, enforces 5-attempt limits,
   * marks OTP consumed (single-use invariant), registers new profiles or fetches existing,
   * and issues a 15-minute access token + rotating refresh token family.
   */
  public static async verifyOtp(
    phone: string,
    otp: string,
    deviceId: string,
    gender?: "male" | "female",
    nickname?: string,
  ) {
    const record = await AuthModel.findValidOtp(phone);
    if (!record) {
      throw new AppError(
        400,
        "OTP_EXPIRED_OR_INVALID",
        "No active OTP found for this phone number.",
      );
    }

    if (record.attempts >= 5) {
      throw new AppError(
        429,
        "TOO_MANY_ATTEMPTS",
        "Maximum verification attempts exceeded. Request a new OTP.",
      );
    }

    const computedHash = CryptoUtil.sha256(otp);
    if (computedHash !== record.code_hash) {
      await AuthModel.incrementOtpAttempts(record.id);
      throw new AppError(400, "INVALID_OTP", "Incorrect OTP provided.");
    }

    // Atomic consumption: prevent replay
    await AuthModel.consumeOtp(record.id);

    let user = await UserModel.findByPhone(phone);
    let isNewUser = false;

    if (!user) {
      if (!gender || !nickname) {
        throw new AppError(
          400,
          "PROFILE_REQUIRED",
          "Gender and Nickname are required for registration.",
        );
      }

      // Wrap user creation in a transaction so the ID sequence lock works
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const userUuid = uuidv4();
        const insertId = await UserModel.create(conn, {
          uuid: userUuid,
          phone,
          gender,
          nickname,
        });
        await conn.commit();

        user = await UserModel.findById(insertId);
        isNewUser = true;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    if (
      user!.account_state === "suspended" ||
      user!.account_state === "banned"
    ) {
      throw new AppError(
        403,
        "ACCOUNT_BLOCKED",
        `Account is currently ${user!.account_state}.`,
      );
    }

    // Establish refresh token family for this device session
    const familyId = uuidv4();
    const rawRefreshToken = crypto.randomBytes(40).toString("hex");
    const refreshHash = CryptoUtil.sha256(rawRefreshToken);
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await AuthModel.insertRefreshToken(pool, {
      userId: user!.id,
      tokenHash: refreshHash,
      familyId,
      deviceId,
      expiresAt: refreshExpiresAt,
    });

    const accessToken = jwt.sign(
      {
        id: user!.id,
        uuid: user!.uuid,
        phone: user!.phone,
        gender: user!.gender,
        role: "user",
      },
      env.JWT_ACCESS_SECRET,
      { expiresIn: "15m" },
    );

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      isNewUser,
      user: {
        id: user!.id,
        uuid: user!.uuid,
        publicId: user!.public_id,
        phone: user!.phone,
        gender: user!.gender,
        nickname: user!.nickname,
        verificationStatus: user!.verification_status,
        walletBalance: user!.wallet_balance,
        isOnline: user!.is_online,
      },
    };
  }

  /**
   * Implements strict token rotation with family-wide revocation upon reuse detection.
   */
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

      // Detection of token reuse / compromise
      if (tokenRecord.revoked_at !== null) {
        await AuthModel.revokeFamily(conn, tokenRecord.family_id);
        await conn.commit();
        throw new AppError(
          401,
          "TOKEN_REUSE_DETECTED",
          "Token replayed. Entire token family revoked.",
        );
      }

      if (new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
        throw new AppError(
          401,
          "REFRESH_EXPIRED",
          "Refresh token has expired.",
        );
      }

      // Consume the current refresh token
      await AuthModel.revokeToken(conn, tokenRecord.id);

      // Issue rotated child token under the identical family_id
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
        throw new AppError(
          403,
          "USER_INACTIVE",
          "User account unavailable or suspended.",
        );
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

  /**
   * Administrative login using bcrypt cost-12 comparison and 4-hour token duration.
   */
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
