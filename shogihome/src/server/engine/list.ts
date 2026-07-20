import net from "net";
import readline from "readline";
import { WebSocket } from "ws";
import { REMOTE_ENGINE_HOST, REMOTE_ENGINE_PORT } from "@/server/config";
import { authenticateSocket } from "@/server/engine/auth";
import type { EngineConfig } from "@/server/engine/types";
import {
  LAN_ENGINE_TYPES,
  encodeEngineListRelayMessage,
  isLanEngineType,
  isRelayEngineId,
  type LanEngineInfo,
} from "@/common/engine/relay_protocol";

export const engineConfigCache = new Map<string, EngineConfig>();

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
};

export const toEngineConfig = (value: unknown): EngineConfig | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const engine = value as Record<string, unknown>;
  if (typeof engine.id !== "string" || engine.id === "" || typeof engine.name !== "string") {
    return null;
  }
  return {
    id: engine.id,
    name: engine.name,
    type: typeof engine.type === "string" || isStringArray(engine.type) ? engine.type : undefined,
    skipAnalysisDB: typeof engine.skipAnalysisDB === "boolean" ? engine.skipAnalysisDB : undefined,
    analysisDBGroupId:
      typeof engine.analysisDBGroupId === "string" ? engine.analysisDBGroupId : undefined,
    analysisDBGroupName:
      typeof engine.analysisDBGroupName === "string" ? engine.analysisDBGroupName : undefined,
  };
};

const toLanEngineInfo = (config: EngineConfig): LanEngineInfo | null => {
  if (!isRelayEngineId(config.id)) return null;

  let types: LanEngineInfo["type"];
  if (Array.isArray(config.type)) {
    if (!config.type.every(isLanEngineType)) return null;
    types = config.type;
  } else if (config.type === "both" || config.type === undefined) {
    types = [...LAN_ENGINE_TYPES];
  } else if (isLanEngineType(config.type)) {
    types = [config.type];
  } else {
    return null;
  }
  return { id: config.id, name: config.name, type: types };
};

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
    let payload: string | null = null;
    try {
      const engines = JSON.parse(data.trim());
      if (Array.isArray(engines)) {
        engineConfigCache.clear();
        engines.forEach((e: unknown) => {
          const config = toEngineConfig(e);
          if (config) {
            engineConfigCache.set(config.id, config);
          }
        });
      }
      if (ws.readyState === WebSocket.OPEN) {
        const sanitizedEngines = Array.isArray(engines)
          ? engines.flatMap((e: unknown) => {
              const config = toEngineConfig(e);
              if (!config) return [];
              const engineInfo = toLanEngineInfo(config);
              return engineInfo ? [engineInfo] : [];
            })
          : [];
        payload = encodeEngineListRelayMessage(sanitizedEngines);
      }
    } catch (e) {
      console.error("Failed to parse engine list from wrapper:", e);
    }

    if (payload && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
      } catch (e) {
        console.error("Failed to send engine list to client:", e);
      }
    }
  });

  socket.on("error", (err) => {
    clearTimeout(connectionTimeout);
    console.error("Failed to get engine list:", err);
  });

  socket.connect(REMOTE_ENGINE_PORT, REMOTE_ENGINE_HOST);
};
