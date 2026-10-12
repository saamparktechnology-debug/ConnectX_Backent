// src/config/env.ts
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z
    .string()
    .default("5000")
    .transform((v) => parseInt(v, 10)),

  // Database (Hostinger Managed MySQL 8)
  DB_HOST: z.string().min(1),
  DB_PORT: z
    .string()
    .default("3306")
    .transform((v) => parseInt(v, 10)),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  DB_CONNECTION_LIMIT: z
    .string()
    .default("25")
    .transform((v) => parseInt(v, 10)),

  // Security & Encryption
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ENCRYPTION_MASTER_KEY: z.string().length(64), // 32-byte hex for AES-256-GCM

  // PayU Decided Specs
  PAYU_MERCHANT_KEY: z.string().min(1),
  PAYU_MERCHANT_SALT: z.string().min(1),
  PAYU_ENV: z.enum(["test", "production"]).default("test"),
  PAYU_SUCCESS_URL: z.string().url(),
  PAYU_FAILURE_URL: z.string().url(),
  PAYU_BASE_URL: z.string().url(),

  // ZEGOCLOUD Audio Engine
  ZEGO_APP_ID: z.string().transform((v) => parseInt(v, 10)),
  ZEGO_SERVER_SECRET: z.string().min(32),

  // CORS
  ALLOWED_ORIGINS: z.string().default("*"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "Invalid environment variables configuration:",
    parsed.error.format(),
  );
  process.exit(1);
}

export const env = parsed.data;
