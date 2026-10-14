// src/validations/index.ts
import { z } from "zod";

export const E164PhoneRegex = /^\+[1-9]\d{7,14}$/;
export const UUIDRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SendOtpSchema = z.object({
  phone: z
    .string()
    .regex(
      E164PhoneRegex,
      "Phone must be valid E.164 format (e.g. +919876543210)",
    ),
});

export const VerifyOtpSchema = z.object({
  phone: z.string().regex(E164PhoneRegex),
  otp: z.string().length(6, "OTP must be exactly 6 digits"),
  deviceId: z.string().min(1).max(128),
});

export const InitiateCallSchema = z.object({
  receiverUuid: z
    .string()
    .regex(UUIDRegex, "receiverUuid must be a valid UUIDv4"),
});

export const InitiateRechargeSchema = z.object({
  amount: z
    .number()
    .min(10, "Minimum recharge is ₹10.00")
    .max(50000, "Maximum recharge is ₹50,000.00"),
  idempotencyKey: z.string().min(10).max(128),
});

export const RequestWithdrawalSchema = z.object({
  amount: z.number().min(100, "Minimum withdrawal is ₹100.00"),
  upiId: z
    .string()
    .regex(/^[\w.-]+@[\w.-]+$/, "Invalid UPI ID format (e.g. user@okhdfcbank)"),
  idempotencyKey: z.string().min(10).max(128),
});

export const SubmitRatingSchema = z.object({
  callId: z.number().positive(),
  rating: z.number().int().min(1).max(5),
  review: z.string().max(500).optional(),
});

export const AdminReviewVerificationSchema = z.object({
  action: z.enum(["approved", "rejected"]),
  reasonCode: z
    .enum([
      "voice_unclear",
      "language_mismatch",
      "other",
      "ai_voice",
      "abusive_content",
      "suspended",
    ])
    .optional(),
  reasonNote: z.string().max(500).optional(),
});
