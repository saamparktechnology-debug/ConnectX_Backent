// src/middleware/error.middleware.ts
import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.util.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function errorMiddleware(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const timestamp = new Date().toISOString();

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      data: null,
      error: { code: err.code, message: err.message, details: err.details },
      meta: { timestamp },
    });
    return;
  }

  // Handle MySQL unique violation (e.g. concurrent active call session)
  if (err.code === "ER_DUP_ENTRY") {
    if (err.message.includes("uq_active_receiver_lock")) {
      res.status(409).json({
        success: false,
        data: null,
        error: {
          code: "RECEIVER_BUSY",
          message: "The companion is currently on another call.",
        },
        meta: { timestamp },
      });
      return;
    }
  }

  logger.error(
    { err, path: req.path, method: req.method },
    "Unhandled internal server error",
  );

  res.status(500).json({
    success: false,
    data: null,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "A critical server error occurred. Transaction aborted safely.",
    },
    meta: { timestamp },
  });
}
