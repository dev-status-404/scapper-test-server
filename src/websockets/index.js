// ws.js (or wherever you initialize)
import { Server } from "socket.io";
import { subscribe, unsubscribe } from "./event.js";
import config from "../config/env.js";
// import { verifyToken } from "../utils/jwt.js";

let io; // Singleton reference to reuse across files

export function initWebSocket(server) {
  const allowedOrigins = (
    config.websocket.ws_cors_origin ||
    config.frontendUrl ||
    "http://localhost:3000,http://localhost:5000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("Not allowed by WebSocket CORS"));
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
    path: config.websocket.ws_path || "/socket.io", // allow custom path if needed
  });

  // ======= Authentication Layer (optional; enable when ready) =======
  /*
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication error: missing token"));
      const user = verifyToken(token);
      socket.user = user; // { id: "...", ... }
      return next();
    } catch (err) {
      return next(new Error("Authentication error"));
    }
  });
  */

  // ======= 🔌 Connection Handler =======
  io.on("connection", (socket) => {
    // Prefer decoded token's user id; fallback to query param; else guest
    const userId =
      socket.user?.id || // uncomment when auth middleware is enabled
      socket.handshake.auth?.userId ||
      socket.handshake.query.userId ||
      `guest_${socket.id}`;

    const userRoom = `user:${String(userId)}`;

    console.log(`User connected: ${userId}`);

    // Default subscriptions / rooms
    subscribe(socket, userRoom);
    subscribe(socket, "broadcast");

    // Optional: client-driven dynamic subscriptions
    socket.on("subscribe", (room) => subscribe(socket, room));
    socket.on("unsubscribe", (room) => unsubscribe(socket, room));

    // Health-check / latency probe (client can emit `ping`, receives { ts, server })
    socket.on("ping", (ack) => {
      const payload = { ts: Date.now(), server: "ok" };
      if (typeof ack === "function") ack(payload);
      else socket.emit("pong", payload);
    });

    // Optional: per-socket error logging
    socket.on("error", (err) => {
      console.warn(`socket error (${userId}):`, err?.message || err);
    });

    socket.on("disconnect", (reason) => {
      unsubscribe(socket, userRoom);
      unsubscribe(socket, "broadcast");
      console.log(`User disconnected: ${userId} (${reason})`);
    });
  });

  console.log("WebSocket server initialized",io);
  return io;
}

// ——— Safe getter
export function getIO() {
  if (!io) {
    throw new Error(
      "Socket.io not initialized. Call initWebSocket(server) first."
    );
  }
  return io;
}

// ——— Helper emitters for your services/controllers
export function sendBroadcastNotification(payload) {
  // expected payload shape: { id?, title, message?, type?, ts? }
  getIO().to("broadcast").emit("notify", payload);
}

export function sendUserNotification(userId, payload) {
  getIO().to(`user:${userId}`).emit("notify", payload);
}