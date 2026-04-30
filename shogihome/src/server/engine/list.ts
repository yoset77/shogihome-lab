import net from "net";
import readline from "readline";
import { WebSocket } from "ws";
import { REMOTE_ENGINE_HOST, REMOTE_ENGINE_PORT } from "@/server/config";
import { authenticateSocket } from "@/server/engine/auth";
import type { EngineConfig } from "@/server/engine/types";

export const engineConfigCache = new Map<string, EngineConfig>();

export const getEngineList = (ws: WebSocket) => {
  console.log(`Fetching engine list from ${REMOTE_ENGINE_HOST}:${REMOTE_ENGINE_PORT}`);
  const socket = new net.Socket();
  let data = "";
  const accessToken = process.env.WRAPPER_ACCESS_TOKEN;
  const MAX_ENGINE_LIST_BYTES = 1 * 1024 * 1024; // 1 MB

  const connectionTimeout = setTimeout(() => {
    socket.destroy(new Error("Connection timed out"));
  }, 5000);

  socket.on("connect", async () => {
    clearTimeout(connectionTimeout);
    try {
      let rl: readline.Interface;
      if (accessToken) {
        rl = await authenticateSocket(socket, accessToken);
      } else {
        rl = readline.createInterface({ input: socket });
      }

      socket.write("list\n");

      rl.on("line", (line) => {
        const str = line.trim();
        if (str !== "") {
          data += str + "\n";
          if (data.length > MAX_ENGINE_LIST_BYTES) {
            console.error("Engine list response too large, aborting.");
            socket.destroy();
          }
        }
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to get engine list: ${message}`);
      socket.destroy();
    }
  });

  socket.on("end", () => {
    try {
      const engines = JSON.parse(data.trim());
      if (Array.isArray(engines)) {
        engineConfigCache.clear();
        engines.forEach((e: EngineConfig) => {
          if (e.id && e.name) {
            engineConfigCache.set(e.id, {
              id: e.id,
              name: e.name,
              type: e.type,
              skipAnalysisDB: e.skipAnalysisDB,
              analysisDBGroupId: e.analysisDBGroupId,
              analysisDBGroupName: e.analysisDBGroupName,
            });
          }
        });
      }
      if (ws.readyState === WebSocket.OPEN) {
        const sanitizedEngines = Array.isArray(engines)
          ? engines.map((e: { id: string; name: string; type?: string | string[] }) => {
              let types: string[] | undefined;
              if (Array.isArray(e.type)) {
                types = e.type;
              } else if (typeof e.type === "string") {
                if (e.type === "both") {
                  types = ["game", "research", "mate"];
                } else {
                  types = [e.type];
                }
              } else {
                types = ["game", "research", "mate"];
              }
              return {
                id: e.id,
                name: e.name,
                type: types,
              };
            })
          : [];
        ws.send(JSON.stringify({ engineList: sanitizedEngines }));
      }
    } catch (e) {
      console.error("Failed to parse engine list from wrapper:", e);
    }
  });

  socket.on("error", (err) => {
    clearTimeout(connectionTimeout);
    console.error("Failed to get engine list:", err);
  });

  socket.connect(REMOTE_ENGINE_PORT, REMOTE_ENGINE_HOST);
};
