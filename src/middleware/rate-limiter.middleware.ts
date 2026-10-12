// src/middleware/rate-limiter.middleware.ts
import rateLimit from "express-rate-limit";

export const otpSendRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // max 3 OTP requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many OTP requests. Please wait 1 minute.",
    },
  },
});

export const otpVerifyRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many verification attempts. Please try again later.",
    },
  },
});

export const callInitiationRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max 10 initiate call taps per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Call attempt limit reached. Please wait.",
    },
  },
});

export const financialRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many transaction requests.",
    },
  },
});
