import net from "net";
import readline from "readline";
import type { WebSocket } from "ws";
import { REMOTE_ENGINE_HOST, REMOTE_ENGINE_PORT } from "@/server/config";
import { authenticateSocket } from "@/server/engine/auth";
import { resourceRegistry } from "@/server/engine/resources";
import type { EngineConfig } from "@/server/engine/types";
import { isRelaySocketOpen, sendRelayFrame } from "@/server/engine/transport";
import {
  LAN_ENGINE_TYPES,
  decodeEngineDocument,
  decodeEngineResourceConfig,
  encodeEngineListRelayMessage,
  isLanEngineType,
  isRelayEngineId,
  type LanEngineInfo,
} from "@/common/engine/relay_protocol";

export const engineConfigCache = new Map<string, EngineConfig>();

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const toEngineConfig = (value: unknown): EngineConfig | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const engine = value as Record<string, unknown>;
  if (typeof engine.id !== "string" || engine.id === "" || typeof engine.name !== "string") {
    return null;
  }
  const config: EngineConfig = {
    id: engine.id,
    name: engine.name,
    type: typeof engine.type === "string" || isStringArray(engine.type) ? engine.type : undefined,
    skipAnalysisDB: typeof engine.skipAnalysisDB === "boolean" ? engine.skipAnalysisDB : undefined,
    analysisDBGroupId:
      typeof engine.analysisDBGroupId === "string" ? engine.analysisDBGroupId : undefined,
    analysisDBGroupName:
      typeof engine.analysisDBGroupName === "string" ? engine.analysisDBGroupName : undefined,
  };
  const options = engine.options;
  if (
    isRecord(options) &&
    typeof options.Threads === "number" &&
    Number.isFinite(options.Threads)
  ) {
    config.threads = options.Threads;
  }
  const resource = decodeEngineResourceConfig(engine.resource);
  if (!resource.ok) return null;
  if (resource.value) config.resource = resource.value;
  return config;
};

/** Parse one `list` response payload: a legacy array or a v2 document. */
export const parseEngineListPayload = (
  value: unknown,
): {
  configs: EngineConfig[];
  resourceSettings: Parameters<typeof resourceRegistry.update>[0];
} | null => {
  const decoded = decodeEngineDocument(value);
  if (!decoded.ok) return null;
  // Invalid resource metadata must fail closed, not silently disable accounting.
  if (
    decoded.value.engines.some(
      (entry) => isRecord(entry) && !decodeEngineResourceConfig(entry.resource).ok,
    )
  )
    return null;
  const configs = decoded.value.engines.flatMap((entry: unknown) => {
    const config = toEngineConfig(entry);
    return config && toLanEngineInfo(config) ? [config] : [];
  });
  return { configs, resourceSettings: decoded.value.resources };
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

const requestEngineConfigs = (): Promise<EngineConfig[]> =>
  new Promise((resolve, reject) => {
    console.log(`Fetching engine list from ${REMOTE_ENGINE_HOST}:${REMOTE_ENGINE_PORT}`);
    const socket = new net.Socket();
    let data = "";
    let receivedBytes = 0;
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

    // Bound bytes before readline can retain a line without a newline.
    socket.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_ENGINE_LIST_BYTES) fail(new Error("Engine list response too large"));
    });

    socket.on("connect", async () => {
      try {
        let rl: readline.Interface;
        if (accessToken) {
          rl = await authenticateSocket(socket, accessToken);
        } else {
          rl = readline.createInterface({ input: socket });
        }
        if (settled) {
          rl.close();
          return;
        }
        rl.on("error", fail);

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
        const payload = parseEngineListPayload(JSON.parse(data.trim()));
        if (!payload) throw new Error("Invalid engine list");
        engineConfigCache.clear();
        for (const config of payload.configs) engineConfigCache.set(config.id, config);
        resourceRegistry.update(payload.resourceSettings);
        settled = true;
        clearTimeout(connectionTimeout);
        resolve(payload.configs);
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

let pendingConfigs: Promise<EngineConfig[]> | undefined;

// Starts must fetch current budgets, not reuse the browser discovery cache.
export function fetchEngineConfigs(): Promise<EngineConfig[]> {
  if (!pendingConfigs) {
    pendingConfigs = requestEngineConfigs().finally(() => {
      pendingConfigs = undefined;
    });
  }
  return pendingConfigs;
}

const DISCOVERY_CACHE_MS = 1000;
let discoveryFrame: string | undefined;
let discoveryExpiresAt = 0;
let retryAfter = 0;
let deliveringList = false;
const listWaiters = new Map<WebSocket, () => void>();

function clearListWaiters(frame?: string): void {
  const waiters = [...listWaiters];
  listWaiters.clear();
  for (const [ws, onClose] of waiters) {
    ws.off("close", onClose);
    if (frame !== undefined) sendRelayFrame(ws, frame);
  }
}

export function getEngineList(ws: WebSocket): void {
  if (!isRelaySocketOpen(ws)) return;
  if (discoveryFrame !== undefined && performance.now() < discoveryExpiresAt) {
    sendRelayFrame(ws, discoveryFrame);
    return;
  }
  if (performance.now() < retryAfter || listWaiters.has(ws)) return;
  const onClose = () => listWaiters.delete(ws);
  listWaiters.set(ws, onClose);
  ws.once("close", onClose);
  if (deliveringList) return;
  deliveringList = true;
  void fetchEngineConfigs()
    .then((configs) => {
      discoveryFrame = encodeEngineListRelayMessage(
        configs.flatMap((config) => {
          const info = toLanEngineInfo(config);
          return info ? [info] : [];
        }),
      );
      discoveryExpiresAt = performance.now() + DISCOVERY_CACHE_MS;
      clearListWaiters(discoveryFrame);
    })
    .catch((error) => {
      retryAfter = performance.now() + DISCOVERY_CACHE_MS;
      clearListWaiters();
      console.error("Failed to fetch engine list:", error);
    })
    .finally(() => {
      deliveringList = false;
    });
}
