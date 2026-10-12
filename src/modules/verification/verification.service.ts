import { v4 as uuidv4 } from "uuid";
import { pool } from "../../config/database.js";
import { VerificationModel } from "../../models/verification.model.js";
import { UserModel } from "../../models/user.model.js";
import { AdminModel } from "../../models/admin.model.js";
import { AppError } from "../../middleware/error.middleware.js";
import { emitToUser } from "../../socket/socket.server.js";

export class VerificationService {
  public static async submitVoice(
    userId: number,
    data: {
      voiceUrl: string;
      durationSec: number;
      mime: string;
      sizeBytes: number;
    },
  ) {
    if (data.durationSec < 5 || data.durationSec > 120) {
      throw new AppError(
        400,
        "INVALID_VOICE_DURATION",
        "Recording must be between 5 and 120 seconds.",
      );
    }

    const uuid = uuidv4();
    await VerificationModel.create({
      uuid,
      userId,
      voiceUrl: data.voiceUrl,
      durationSec: data.durationSec,
      mime: data.mime,
      sizeBytes: data.sizeBytes,
    });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await VerificationModel.setUserVerificationStatus(
        conn,
        userId,
        "pending",
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    // Notify the user (in case they have another device open)
    emitToUser(userId, "verification:updated", { status: "pending" });

    return { submissionUuid: uuid, status: "pending" };
  }

  public static async reviewSubmission(
    adminId: number,
    submissionId: number,
    action: "approved" | "rejected",
    reasonCode?: string,
    reasonNote?: string,
  ) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const submission = await VerificationModel.lockById(conn, submissionId);
      if (!submission || submission.status !== "pending") {
        throw new AppError(
          400,
          "SUBMISSION_NOT_PENDING",
          "Submission is not in a pending state.",
        );
      }

      if (action === "approved") {
        await VerificationModel.review(
          conn,
          submission.id,
          "approved",
          adminId,
        );
        await VerificationModel.setUserVerificationStatus(
          conn,
          submission.user_id,
          "approved",
        );
      } else {
        if (!reasonCode)
          throw new AppError(
            400,
            "REASON_REQUIRED",
            "Rejection reason code is mandatory.",
          );

        const isTerminal = [
          "ai_voice",
          "abusive_content",
          "suspended",
        ].includes(reasonCode);

        await VerificationModel.review(
          conn,
          submission.id,
          "rejected",
          adminId,
          reasonCode,
          reasonNote,
        );
        await VerificationModel.setUserVerificationStatus(
          conn,
          submission.user_id,
          "rejected",
        );

        if (isTerminal) {
          await UserModel.suspendAccount(
            conn,
            submission.user_id,
            adminId,
            `Verification Rejected: ${reasonCode}`,
          );
        }
      }

      await AdminModel.insertAuditLog({
        adminId,
        action: `verification.${action}`,
        entityType: "verification_submission",
        entityId: String(submission.id),
        beforeState: { status: submission.status },
        afterState: { action, reasonCode, reasonNote },
      });

      await conn.commit();

      // Notify the user over the socket
      emitToUser(submission.user_id, "verification:updated", {
        status: action === "approved" ? "approved" : "rejected",
        reason: reasonCode,
        note: reasonNote,
      });

      return { id: submission.id, result: action };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}
