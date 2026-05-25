// index.js
import http from "http";
import app from "./app.js";
import { PORT } from "./config/env.js";
import logger from "./utils/logger.js";
import { initWebSocket } from "./websockets/index.js";
import {
  bindErrorContext,
  captureException,
  flushMonitoring,
  toError,
} from "./monitoring/index.js";

// Create the HTTP server from Express
const server = http.createServer(app);

// Attach Socket.IO to this same HTTP server
initWebSocket(server);

// Start listening
server.listen(PORT,"0.0.0.0", () => {
  logger.info(`🚀 Server listening on http://localhost:${PORT}`);
});

server.on("error", async (error) => {
  const normalizedError = toError(error, "http-server-error");
  logger.error({ err: normalizedError }, "HTTP server error");
  captureException(
    normalizedError,
    bindErrorContext({
      tags: { area: "http-server", event: "server-error" },
    }),
  );
  await flushMonitoring();
  process.exit(1);
});

// Error handling
process.on("unhandledRejection", async (err) => {
  const normalizedError = toError(err, "unhandled-rejection");
  logger.error({ err: normalizedError }, "Unhandled rejection");
  captureException(
    normalizedError,
    bindErrorContext({
      tags: { area: "process", event: "unhandledRejection" },
    }),
  );
  await flushMonitoring();
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 2500).unref();
});

process.on("uncaughtException", async (err) => {
  const normalizedError = toError(err, "uncaught-exception");
  logger.error({ err: normalizedError }, "Uncaught exception");
  captureException(
    normalizedError,
    bindErrorContext({
      tags: { area: "process", event: "uncaughtException" },
    }),
  );
  await flushMonitoring();
  process.exit(1);
});

export default server;
