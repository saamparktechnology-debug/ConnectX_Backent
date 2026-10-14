import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { pool } from "../config/database.js";
import { logger } from "../utils/logger.util.js";

const expo = new Expo();

export class PushService {
  /** Send a push to every device of a user. Best-effort. */
  public static async pushToUser(
    userId: number,
    payload: {
      title: string;
      body: string;
      data?: Record<string, any>;
      sound?: "default" | null;
      priority?: "default" | "high";
      channelId?: string;
    },
  ): Promise<void> {
    try {
      const [rows]: any = await pool.execute(
        `SELECT push_token FROM user_devices
          WHERE user_id = ? AND push_token IS NOT NULL AND push_enabled = 1`,
        [userId],
      );

      const tokens = rows
        .map((r: any) => r.push_token)
        .filter((t: any) => Expo.isExpoPushToken(t));
      if (!tokens.length) return;

      const messages: ExpoPushMessage[] = tokens.map((to: string) => ({
        to,
        sound: payload.sound ?? "default",
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
        priority: payload.priority ?? "high",
        channelId: payload.channelId ?? "default",
      }));

      const chunks = expo.chunkPushNotifications(messages);
      const tickets: ExpoPushTicket[] = [];
      for (const chunk of chunks) {
        try {
          const t = await expo.sendPushNotificationsAsync(chunk);
          tickets.push(...t);
        } catch (e) {
          logger.warn({ e }, "push send failed");
        }
      }
      logger.info({ userId, count: tokens.length }, "push sent");
    } catch (e) {
      logger.warn({ e, userId }, "push service error");
    }
  }
}
