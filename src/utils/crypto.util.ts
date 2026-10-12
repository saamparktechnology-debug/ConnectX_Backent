// src/utils/crypto.util.ts
import crypto from "crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MASTER_KEY = Buffer.from(env.ENCRYPTION_MASTER_KEY, "hex");

export class CryptoUtil {
  public static sha256(input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex");
  }

  public static sha512(input: string): string {
    return crypto.createHash("sha512").update(input).digest("hex");
  }

  public static encryptAES256GCM(plainText: string): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  }

  public static decryptAES256GCM(cipherBuffer: Buffer): string {
    const iv = cipherBuffer.subarray(0, IV_LENGTH);
    const tag = cipherBuffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = cipherBuffer.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
    decipher.setAuthTag(tag);
    return (
      decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8")
    );
  }
}
