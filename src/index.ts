import express from "express";
import helmet from "helmet";
import cors from "cors";
import http from "node:http";
import { env } from "./config/env.js";
import { verifyDatabaseConnection } from "./config/database.js";
import { logger } from "./utils/logger.util.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { apiRouter } from "./routes/index.js";
import { startCallSweeperDaemon } from "./jobs/call-sweeper.job.js";
import { initSocketServer } from "./socket/socket.server.js";
import { startTargetsAwardDaemon } from "./jobs/targets-award.job.js";

const app = express();

// 1. CORS MUST BE FIRST
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:19006",
  "exp://127.0.0.1:8081",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "x-idempotency-key",
    ],
    exposedHeaders: ["Authorization"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  }),
);

// 2. Preflight
app.options("*", cors());

// 3. Helmet
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// 4. Body parsers
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// 5. Static uploads
import path from "node:path";
app.use(
  "/uploads",
  express.static(path.resolve(process.env.UPLOAD_ROOT || "./uploads"), {
    maxAge: "1d",
    fallthrough: false,
  }),
);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "UP", timestamp: new Date().toISOString() });
});

// 6. API routes
app.use("/api/v1", apiRouter);

// Error middleware
app.use(errorMiddleware);

async function startServer() {
  await verifyDatabaseConnection();
  startCallSweeperDaemon();
  startTargetsAwardDaemon();

  // Create HTTP server (instead of app.listen) so Socket.IO can share it
  const server = http.createServer(app);

  // Attach Socket.IO to the same server on the same port
  initSocketServer(server);

  server.listen(env.PORT, "0.0.0.0", () => {
    logger.info(
      `Connect24x Production API Engine listening on port ${env.PORT} [${env.NODE_ENV}]`,
    );
    logger.info(`Socket.IO attached at /socket.io`);
  });
}

startServer();
