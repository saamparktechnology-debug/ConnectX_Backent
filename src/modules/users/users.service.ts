// src/modules/users/users.service.ts
import { pool } from "../../config/database.js";
import { UserModel } from "../../models/user.model.js";
import { AppError } from "../../middleware/error.middleware.js";

export class UsersService {
  public static async toggleOnlineStatus(
    userId: number,
    requestedOnlineState: boolean,
  ) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const user = await UserModel.lockById(conn, userId);
      if (!user) {
        throw new AppError(404, "USER_NOT_FOUND", "User record not found.");
      }

      // Rule: Only female companions receive incoming calls
      if (user.gender !== "female") {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Only female companion profiles can set availability for calls.",
        );
      }

      // Rule: Cannot go online unless completely verified & approved
      if (requestedOnlineState === true) {
        if (user.verification_status !== "approved") {
          throw new AppError(
            403,
            "VERIFICATION_REQUIRED",
            `Cannot go online. Your profile verification status is: '${user.verification_status}'.`,
          );
        }

        if (user.account_state !== "active") {
          throw new AppError(
            403,
            "ACCOUNT_BLOCKED",
            `Cannot go online while account is ${user.account_state}.`,
          );
        }
      }

      // Update online state in database
      await conn.execute(
        `UPDATE users 
         SET is_online = ?, last_seen_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) 
         WHERE id = ?`,
        [requestedOnlineState, userId],
      );

      await conn.commit();
      return { isOnline: requestedOnlineState };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}
