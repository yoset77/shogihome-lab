import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { ExtendedWebSocket } from "@/server/engine/types";
import { ALLOWED_ORIGINS } from "@/server/config";
import { isValidHost } from "@/server/security";
import type { GameSessionManager } from "@/server/game/manager";
import { decodeGameClientFrame, decodeGameConnection } from "@/common/game/protocol";
import { HttpError } from "@/server/errors";

interface WebSocketSession {
  attach(ws: ExtendedWebSocket): void;
}

interface WebSocketSessionManager {
  getOrCreateSession(sessionId: string): WebSocketSession | null;
}

export const createEngineWebSocketServer = (
  server: http.Server,
  sessionManager: WebSocketSessionManager,
  gameManager?: GameSessionManager,
) => {
  const wss = new WebSocketServer({
    noServer: true,
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

  // A single listener owns upgrade dispatch for both transports.
  const upgrade: Parameters<typeof server.on<"upgrade">>[1] = (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      if (
        url.pathname !== "/" &&
        !/^\/ws\/game-sessions\/[a-zA-Z0-9_-]{1,100}$/.test(url.pathname)
      ) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  };
  server.on("upgrade", upgrade);
  server.once("close", () => wss.close());

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
    server.off("upgrade", upgrade);
  });

  wss.on("connection", (ws: ExtendedWebSocket, req) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    let url: URL;
    try {
      url = new URL(req.url ?? "", `http://${req.headers.host}`);
    } catch {
      console.warn("Blocked connection with invalid WebSocket URL");
      ws.close(1008, "Invalid URL");
      return;
    }
    if (url.pathname.startsWith("/ws/game-sessions/")) {
      try {
        if (
          !gameManager ||
          url.searchParams.get("serverInstanceId") !== gameManager.serverInstanceId
        ) {
          ws.close(4004, "Game expired");
          return;
        }
        const session = gameManager.get(url.pathname.substring("/ws/game-sessions/".length));
        const epoch = url.searchParams.get("controllerEpoch");
        const decodedConnection = decodeGameConnection({
          connectionId: url.searchParams.get("connectionId"),
          controllerEpoch: epoch && /^\d+$/.test(epoch) ? Number(epoch) : undefined,
        });
        if (!decodedConnection.ok) {
          ws.close(1008, "Invalid game connection");
          return;
        }
        const connection = session.connect(
          url.searchParams.get("controllerId") ?? "",
          (frame) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 32 * 1024 * 1024) {
              ws.close(1013, "Slow game consumer");
              return;
            }
            ws.send(JSON.stringify(frame));
          },
          (code = 4004) => ws.close(code, "Controller disconnected"),
          decodedConnection.value,
        );
        let messages = 0;
        let windowStart = Date.now();
        ws.on("message", (data, binary) => {
          if (Date.now() - windowStart >= 10_000) {
            windowStart = Date.now();
            messages = 0;
          }
          if (binary || ++messages > 200) {
            ws.close(1008, "Invalid game message");
            return;
          }
          try {
            const decoded = decodeGameClientFrame(JSON.parse(data.toString()));
            if (!decoded.ok) {
              ws.close(1008, "Invalid game message");
              return;
            }
            if (decoded.value.type === "heartbeat") {
              if (decoded.value.controllerEpoch !== connection.epoch) {
                ws.close(1008, "Invalid heartbeat");
                return;
              }
              connection.heartbeat();
            } else session.annotate(decoded.value.value);
          } catch {
            ws.close(1008, "Invalid heartbeat");
          }
        });
        ws.on("close", () => connection.disconnect());
        ws.on("error", () => connection.disconnect());
      } catch (error) {
        ws.close(
          error instanceof HttpError && error.status === 409 ? 4001 : 4004,
          "Game unavailable",
        );
      }
      return;
    }
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
