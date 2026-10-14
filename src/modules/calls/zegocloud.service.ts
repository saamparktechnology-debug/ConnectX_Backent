// src/modules/calls/zegocloud.service.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";

export class ZegoCloudService {
  /**
   * Generates official ZEGOCLOUD Token04 room privilege authentication token.
   * Requires ZEGO_SERVER_SECRET to be the 32-character ServerSecret from Zego Console.
   */
  public static generateRoomToken(
    userId: string,
    roomId: string,
    effectiveDurationSec: number = 3600,
  ): string {
    const secret = (env.ZEGO_SERVER_SECRET || "").trim();
    if (secret.length !== 32) {
      throw new Error(
        `ZEGO_SERVER_SECRET must be exactly 32 characters (got ${secret.length}). Check your ZEGOCLOUD console.`,
      );
    }

    const createTime = Math.floor(Date.now() / 1000);
    const expireTime = createTime + effectiveDurationSec;
    const nonce = crypto.randomInt(-2147483648, 2147483647);

    // Room-level privileges must be stringified inside the `payload` property
    const innerPayload = JSON.stringify({
      room_id: roomId,
      privilege: { 1: 1, 2: 1 }, // 1: Login Room, 2: Publish Stream
      stream_id_list: null,
    });

    const tokenInfo = JSON.stringify({
      app_id: Number(env.ZEGO_APP_ID),
      user_id: String(userId),
      nonce,
      ctime: createTime,
      expire: expireTime,
      payload: innerPayload,
    });

    // 16-byte random ASCII IV
    const ivStr = crypto.randomBytes(8).toString("hex"); // 16 chars
    const iv = Buffer.from(ivStr, "utf8");
    const key = Buffer.from(secret, "utf8"); // 32 bytes -> aes-256-cbc

    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(tokenInfo, "utf8"),
      cipher.final(),
    ]);

    // Token04 binary layout:
    // [8B expire BigInt64BE] + [2B iv.length UInt16BE] + [16B iv] + [2B encrypted.length UInt16BE] + [encrypted]
    // Note: Standard Zego Token04 packs: 8 + 2 + 16 + 2 + encrypted.length = 28 + encrypted.length
    const tokenBuffer = Buffer.alloc(28 + encrypted.length);
    let offset = 0;

    tokenBuffer.writeBigInt64BE(BigInt(expireTime), offset);
    offset += 8;

    tokenBuffer.writeUInt16BE(iv.length, offset);
    offset += 2;

    iv.copy(tokenBuffer, offset);
    offset += iv.length;

    tokenBuffer.writeUInt16BE(encrypted.length, offset);
    offset += 2;

    encrypted.copy(tokenBuffer, offset);

    return "04" + tokenBuffer.toString("base64");
  }
}
