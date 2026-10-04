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

export const toLanEngineInfo = (config: EngineConfig): LanEngineInfo | null => {
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

export const fetchEngineConfigs = (): Promise<EngineConfig[]> =>
  new Promise((resolve, reject) => {
    console.log(`Fetching engine list from ${REMOTE_ENGINE_HOST}:${REMOTE_ENGINE_PORT}`);
    const socket = new net.Socket();
    let data = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimeout);
      socket.destroy();
      reject(error);
    };
    const accessToken = process.env.WRAPPER_ACCESS_TOKEN;
    const MAX_ENGINE_LIST_BYTES = 1 * 1024 * 1024; // 1 MB

    const connectionTimeout = setTimeout(() => {
      fail(new Error("Engine list request timed out"));
    }, 5000);

    socket.on("connect", async () => {
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
          if (str !== "" && !settled) {
            data += str + "\n";
            if (Buffer.byteLength(data) > MAX_ENGINE_LIST_BYTES)
              fail(new Error("Engine list response too large"));
          }
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to get engine list: ${message}`);
        fail(new Error("Failed to authenticate engine list request"));
      }
    });

    socket.on("end", () => {
      if (settled) return;
      try {
        const engines: unknown = JSON.parse(data.trim());
        if (!Array.isArray(engines)) throw new Error("Invalid engine list");
        const configs = engines.flatMap((value: unknown) => {
          const config = toEngineConfig(value);
          return config && toLanEngineInfo(config) ? [config] : [];
        });
        engineConfigCache.clear();
        for (const config of configs) engineConfigCache.set(config.id, config);
        settled = true;
        clearTimeout(connectionTimeout);
        resolve(configs);
      } catch (e) {
        console.error("Failed to parse engine list from wrapper:", e);
        fail(new Error("Invalid engine list"));
      }
    });

    socket.on("error", (err) => {
      console.error("Failed to get engine list:", err);
      fail(new Error("Failed to get engine list"));
    });
    socket.on("close", () => {
      if (!settled) fail(new Error("Engine list connection closed"));
    });

    socket.connect(REMOTE_ENGINE_PORT, REMOTE_ENGINE_HOST);
  });

export const getEngineList = (ws: WebSocket) => {
  void fetchEngineConfigs()
    .then((configs) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        encodeEngineListRelayMessage(
          configs.flatMap((config) => {
            const info = toLanEngineInfo(config);
            return info ? [info] : [];
          }),
        ),
      );
    })
    .catch((error) => console.error("Failed to fetch engine list:", error));
};
