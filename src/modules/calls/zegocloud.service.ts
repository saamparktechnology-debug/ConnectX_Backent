// src/modules/calls/zegocloud.service.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";

export class ZegoCloudService {
  public static generateRoomToken(
    userId: string,
    roomId: string,
    effectiveDurationSec: number = 3600,
  ): string {
    const secret = (env.ZEGO_SERVER_SECRET || "").trim();
    if (secret.length !== 32) {
      throw new Error(
        `Invalid ZEGO_SERVER_SECRET length (${secret.length}). Must be the 32-char ServerSecret from Zego Console.`,
      );
    }

    const createTime = Math.floor(Date.now() / 1000);
    const expireTime = createTime + effectiveDurationSec;
    const nonce = crypto.randomInt(-2147483648, 2147483647);

    // ZegoUIKitPrebuiltCall requires payload to be "" (or general token04 format)
    const tokenInfo = JSON.stringify({
      app_id: Number(env.ZEGO_APP_ID),
      user_id: String(userId),
      nonce,
      ctime: createTime,
      expire: expireTime,
      payload: "",
    });

    // 16-byte IV
    const iv = crypto.randomBytes(8).toString("hex"); // 16 ASCII chars = 16 bytes
    const key = Buffer.from(secret, "utf8"); // 32 ASCII chars = 32 bytes (AES-256-CBC)

    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      key,
      Buffer.from(iv, "utf8"),
    );
    const encrypted = Buffer.concat([
      cipher.update(tokenInfo, "utf8"),
      cipher.final(),
    ]);

    // Official ZegoServerAssistant Token04 binary packing (28 + encrypted.length bytes):
    // [8B expireTime BigInt64BE] + [2B iv.length UInt16BE] + [16B iv] + [2B encrypted.length UInt16BE] + [encrypted]
    const b1 = Buffer.alloc(8);
    b1.writeBigInt64BE(BigInt(expireTime), 0);

    const b2 = Buffer.alloc(2);
    b2.writeUInt16BE(iv.length, 0);

    const b3 = Buffer.from(iv, "utf8");

    const b4 = Buffer.alloc(2);
    b4.writeUInt16BE(encrypted.length, 0);

    const result = Buffer.concat([b1, b2, b3, b4, encrypted]);
    return "04" + result.toString("base64");
  }
}
