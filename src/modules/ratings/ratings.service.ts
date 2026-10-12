// src/modules/ratings/ratings.service.ts
import { pool } from "../../config/database.js";
import { RatingModel } from "../../models/rating.model.js";
import { AppError } from "../../middleware/error.middleware.js";

export class RatingsService {
  public static async submitRating(
    raterId: number,
    callHistoryId: number,
    rating: number,
    review?: string,
  ) {
    // 1. Fetch call history record
    const [calls]: any = await pool.execute(
      `SELECT * FROM calls_history WHERE id = ?`,
      [callHistoryId],
    );
    if (!calls.length) {
      throw new AppError(404, "CALL_NOT_FOUND", "Call record not found.");
    }

    const call = calls[0];
    if (call.caller_id !== raterId && call.receiver_id !== raterId) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "You were not a participant in this call.",
      );
    }

    // Determine target
    const rateeId =
      call.caller_id === raterId ? call.receiver_id : call.caller_id;

    // Check duplicate
    const alreadySubmitted = await RatingModel.hasRated(callHistoryId, raterId);
    if (alreadySubmitted) {
      throw new AppError(
        400,
        "ALREADY_RATED",
        "Rating already submitted for this call.",
      );
    }

    // Spec: Ratings of 1 or 2 are automatically flagged for admin review
    const isFlagged = rating <= 2;
    const flaggedReason = isFlagged
      ? `Low rating threshold (${rating}/5)`
      : null;

    const ratingId = await RatingModel.create({
      callId: callHistoryId,
      raterId,
      rateeId,
      rating,
      review,
      isFlagged,
      flaggedReason,
    });

    return { ratingId, isFlagged };
  }
}
