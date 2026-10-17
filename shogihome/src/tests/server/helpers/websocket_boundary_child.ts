import http from "node:http";
import { createEngineWebSocketServer } from "@/server/websocket";
import { EngineSession } from "@/server/engine/session";

const sessions = new Map<string, EngineSession>();
let lateErrors = 0;
const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ sessions: [...sessions.keys()], lateErrors }));
});
const wss = createEngineWebSocketServer(server, {
  getOrCreateSession: (id) => {
    if (id === "rejected-session") return null;
    let session = sessions.get(id);
    if (!session) {
      session = new EngineSession(id, () => sessions.delete(id));
      sessions.set(id, session);
    }
    return session;
  },
});
wss.on("connection", (ws, req) => {
  if (new URL(req.url!, "http://localhost").searchParams.has("lateError")) {
    ws.once("close", () => {
      setImmediate(() => {
        ws.emit("error", new Error("Delayed transport error from a replaced socket"));
        lateErrors++;
      });
    });
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") {
    process.stdout.write(`READY:${address.port}\n`);
  }
});
