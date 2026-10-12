import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { AppError } from "./error.middleware.js";

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || "./uploads";
const AVATAR_DIR = path.join(UPLOAD_ROOT, "avatars");

if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const id = crypto.randomUUID();
    cb(null, `avatar_${id}${ext}`);
  },
});

export const uploadAvatar = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(
        new AppError(
          400,
          "INVALID_FILE_TYPE",
          `Unsupported image type: ${file.mimetype}. Use JPEG, PNG, or WebP.`,
        ),
      );
    }
    cb(null, true);
  },
}).single("avatar");
