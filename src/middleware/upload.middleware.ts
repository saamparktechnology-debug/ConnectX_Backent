import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { AppError } from "./error.middleware.js";

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || "./uploads";
const RECORDING_DIR = path.join(UPLOAD_ROOT, "recordings");

// Ensure directory exists at boot
if (!fs.existsSync(RECORDING_DIR)) {
  fs.mkdirSync(RECORDING_DIR, { recursive: true });
}

const ALLOWED_MIME = new Set([
  "audio/m4a",
  "audio/mp4",
  "audio/x-m4a",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
]);

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RECORDING_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".m4a";
    const id = crypto.randomUUID();
    cb(null, `voice_${id}${ext}`);
  },
});

export const uploadVoice = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(
        new AppError(
          400,
          "INVALID_FILE_TYPE",
          `Unsupported audio type: ${file.mimetype}.`,
        ),
      );
    }
    cb(null, true);
  },
}).single("voice");
