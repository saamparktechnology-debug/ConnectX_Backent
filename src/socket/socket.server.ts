import { Server as HTTPServer } from "node:http";
import { Server as SocketIOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.util.js";

/**
 * Socket.IO transport for real-time call signaling.
 *
 * Rooms:
 *   - `user:<userId>`   — every authenticated socket for a given user
 *   - `role:admin`      — reserved for future admin live dashboards
 *
 * Events emitted by the server:
 *   - `call:incoming`   — { sessionUuid, roomId, callerNickname, callerAvatar, secondsUntilExpiry }
 *   - `call:accepted`   — { sessionUuid }
 *   - `call:rejected`   — { sessionUuid }
 *   - `call:ended`      — { sessionUuid, endReason }
 *   - `call:missed`     — { sessionUuid }
 *   - `wallet:updated`  — { balance }
 *   - `verification:updated` — { status, reason }
 *
 * Auth:
 *   Client connects with `auth: { token }` where token is the JWT access token.
 *   Invalid → connection rejected.
 */

type JwtUser = {
  id: number;
  uuid: string;
  phone: string;
  gender: "male" | "female";
  role: "user" | "admin";
};

let io: SocketIOServer | null = null;

export function initSocketServer(httpServer: HTTPServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
    path: "/socket.io",
    transports: ["websocket", "polling"],
  });

  // ── Auth middleware ──────────────────────────────────────────────
  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ||
        (socket.handshake.headers?.authorization
          ?.toString()
          .replace("Bearer ", "") ??
          undefined);

      if (!token) return next(new Error("NO_TOKEN"));

      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtUser;
      (socket.data as { user: JwtUser }).user = payload;
      next();
    } catch {
      next(new Error("INVALID_TOKEN"));
    }
  });

  // ── Connection handler ───────────────────────────────────────────
  io.on("connection", (socket: Socket) => {
    const user = (socket.data as { user: JwtUser }).user;

    logger.info(
      { userId: user.id, socketId: socket.id, gender: user.gender },
      "[socket] user connected",
    );

    // Personal room — for events addressed to this user
    socket.join(`user:${user.id}`);

    // Admin room (future dashboards)
    if (user.role === "admin") {
      socket.join("role:admin");
    }

    // Ack so the client knows it's connected
    socket.emit("connected", { userId: user.id, at: Date.now() });

    socket.on("disconnect", (reason) => {
      logger.info(
        { userId: user.id, socketId: socket.id, reason },
        "[socket] user disconnected",
      );
    });
  });

  logger.info("[socket] Socket.IO server initialised");
  return io;
}

/**
 * Get the initialised socket server. Throws if called before initSocketServer.
 */
export function getIO(): SocketIOServer {
  if (!io) {
    throw new Error(
      "Socket.IO server not initialised. Call initSocketServer first.",
    );
  }
  return io;
}

// ── Emit helpers ──────────────────────────────────────────────────

export function emitToUser(
  userId: number,
  event: string,
  payload: unknown,
): void {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

export function isUserConnected(userId: number): boolean {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  return !!room && room.size > 0;
}
