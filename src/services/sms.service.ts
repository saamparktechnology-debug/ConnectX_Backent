//src/services/sms.service.ts
// import { logger } from "../utils/logger.util.js";

// export class SmsService {
//   public static async dispatchOtp(phone: string, otp: string): Promise<void> {
//     const provider = process.env.SMS_PROVIDER || "mock";

//     // Mock Mode: Print OTP directly to terminal with high visibility
//     if (provider === "mock" || process.env.NODE_ENV !== "development") {
//       logger.info(
//         `\n======================================================\n` +
//           `[MOCK SMS GATEWAY]\n` +
//           `Phone Number : ${phone}\n` +
//           `OTP Code     : ${otp}\n` +
//           `Expiry       : 5 Minutes\n` +
//           `======================================================\n`,
//       );
//       return;
//     }
//   }
// }

import { logger } from "../utils/logger.util.js";

export class SmsService {
  public static async dispatchOtp(phone: string, otp: string): Promise<void> {
    const provider = process.env.SMS_PROVIDER || "mock";

    if (provider === "mock") {
      logger.info(
        `\n======================================================\n` +
          `[MOCK SMS GATEWAY]\n` +
          `Phone Number : ${phone}\n` +
          `OTP Code     : ${otp}\n` +
          `Expiry       : 5 Minutes\n` +
          `======================================================\n`,
      );
      return;
    }

    // Real providers (Twilio / MSG91) — implement later
    logger.warn({ phone, provider }, "[sms] provider not implemented");
  }
}
