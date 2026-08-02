import http from "http";
import { WebSocketServer } from "ws";
import type { ExtendedWebSocket } from "@/server/engine/types";
import { ALLOWED_ORIGINS } from "@/server/config";
import { isValidHost } from "@/server/security";

interface WebSocketSession {
  attach(ws: ExtendedWebSocket): void;
}

interface WebSocketSessionManager {
  getOrCreateSession(sessionId: string): WebSocketSession | null;
}

export const createEngineWebSocketServer = (
  server: http.Server,
  sessionManager: WebSocketSessionManager,
) => {
  const wss = new WebSocketServer({
    server,
    maxPayload: 1 * 1024 * 1024,
    perMessageDeflate: false,
    verifyClient: (info, cb) => {
      const origin = info.origin;
      const req = info.req;

      // Check Origin
      if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        console.warn(`Blocked connection from unauthorized origin: ${origin}`);
        cb(false, 403, "Forbidden");
        return;
      }

      // Check Host header (DNS Rebinding protection)
      if (!isValidHost(req)) {
        console.warn(`Blocked connection with invalid Host header: ${req.headers.host}`);
        cb(false, 403, "Forbidden (Invalid Host)");
        return;
      }

      cb(true);
    },
  });

  const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws: ExtendedWebSocket) {
      if (ws.isAlive === false) {
        console.log("Client connection timed out, terminating.");
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 20000);
  interval.unref();

  wss.on("close", function close() {
    clearInterval(interval);
  });

  wss.on("connection", (ws: ExtendedWebSocket, req) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    const url = new URL(req.url!, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");
    const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

    if (!sessionId) {
      console.warn("Connection attempt without sessionId. Closing.");
      ws.close(1008, "sessionId required");
      return;
    }

    if (!SESSION_ID_REGEX.test(sessionId)) {
      console.warn(
        `Blocked connection attempt with invalid sessionId format: ${sessionId.substring(0, 32)}`,
      );
      ws.close(1008, "Invalid sessionId format");
      return;
    }

    const session = sessionManager.getOrCreateSession(sessionId);
    if (!session) {
      ws.close(1013, "Session limit reached");
      return;
    }
    session.attach(ws);
  });

  return wss;
};
