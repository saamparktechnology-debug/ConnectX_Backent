// src/types/common.ts
import { Request } from "express";

export interface AuthenticatedUser {
  id: number;
  uuid: string;
  phone: string;
  gender: "male" | "female";
  role: "user" | "admin";
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data: T | null;
  error: {
    code: string;
    message: string;
    details?: any;
  } | null;
  meta?: {
    timestamp: string;
    [key: string]: any;
  };
}
