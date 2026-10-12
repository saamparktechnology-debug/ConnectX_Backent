// src/modules/calls/zegocloud.service.ts
import crypto from "crypto";
import { env } from "../../config/env.js";

export class ZegoCloudService {
  /**
   * Generates standard ZEGOCLOUD room privilege authentication token
   */
  public static generateRoomToken(
    userId: string,
    roomId: string,
    effectiveDurationSec: number = 3600,
  ): string {
    const createTime = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(4).readUInt32BE(0);

    const payload = {
      app_id: env.ZEGO_APP_ID,
      user_id: userId,
      room_id: roomId,
      privilege: { 1: 1, 2: 1 }, // 1: Login Room, 2: Publish Stream
      create_time: createTime,
      expire_time: createTime + effectiveDurationSec,
      nonce,
    };

    const payloadString = JSON.stringify(payload);
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(env.ZEGO_SERVER_SECRET, "utf8").subarray(0, 16);
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(payloadString, "utf8"),
      cipher.final(),
    ]);

    const tokenBuffer = Buffer.alloc(28 + encrypted.length);
    tokenBuffer.writeBigInt64BE(BigInt(payload.expire_time), 0);
    tokenBuffer.writeUInt32BE(env.ZEGO_APP_ID, 8);
    tokenBuffer.writeUInt32BE(iv.length, 12);
    iv.copy(tokenBuffer, 16);
    tokenBuffer.writeUInt32BE(encrypted.length, 16 + iv.length);
    encrypted.copy(tokenBuffer, 20 + iv.length);

    return "04" + tokenBuffer.toString("base64");
  }
}
