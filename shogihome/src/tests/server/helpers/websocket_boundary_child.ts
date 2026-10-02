import http from "node:http";
import { createEngineWebSocketServer } from "@/server/websocket";

const server = http.createServer();
let sessions = 0;
createEngineWebSocketServer(server, {
  getOrCreateSession: () => {
    sessions++;
    return { attach: (ws) => ws.send(`ready:${sessions}`) };
  },
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") {
    process.stdout.write(`READY:${address.port}\n`);
  }
});
