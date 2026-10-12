// src/middleware/auth.middleware.ts
import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AuthenticatedRequest, AuthenticatedUser } from "../types/common.js";
import { AppError } from "./error.middleware.js";

export function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError(
      401,
      "UNAUTHORIZED",
      "Missing or malformed Authorization header",
    );
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(
      token,
      env.JWT_ACCESS_SECRET,
    ) as AuthenticatedUser;
    req.user = decoded;
    next();
  } catch (error) {
    throw new AppError(
      401,
      "TOKEN_EXPIRED",
      "Access token is invalid or expired",
    );
  }
}

export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  authenticate(req, res, () => {
    if (req.user?.role !== "admin") {
      throw new AppError(403, "FORBIDDEN", "Administrative privilege required");
    }
    next();
  });
}
