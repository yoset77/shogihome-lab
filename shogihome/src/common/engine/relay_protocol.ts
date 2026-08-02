export const RELAY_STATES = ["uninitialized", "starting", "ready", "thinking", "stopped"] as const;

export type RelayState = (typeof RELAY_STATES)[number];

export type ActiveRelayState = "starting" | "ready" | "thinking";

export type InactiveRelayState = "uninitialized" | "stopped";

export const LAN_ENGINE_TYPES = ["game", "research", "mate"] as const;

export type LanEngineType = (typeof LAN_ENGINE_TYPES)[number];

export type LanEngineInfo = {
  id: string;
  name: string;
  type?: LanEngineType[];
};

export type RelayNotice = "pong" | "engineReady" | "engineStopped";

type SessionRelayStatePayload =
  | { type: "state"; state: ActiveRelayState; engineId: string }
  | { type: "state"; state: InactiveRelayState; engineId: null };

export type SessionRelayPayload =
  | SessionRelayStatePayload
  | { type: "engineOutput"; positionCommand: string | null; output: string }
  | { type: "notice"; notice: RelayNotice }
  | { type: "error"; message: string };

type RelayDelay = { delay?: number };

type ServerRelayStateMessage = SessionRelayStatePayload & RelayDelay;

export type ServerRelayMessage =
  | ServerRelayStateMessage
  | ({ type: "engineOutput"; positionCommand: string | null; output: string } & RelayDelay)
  | ({ type: "notice"; notice: RelayNotice } & RelayDelay)
  | ({ type: "error"; message: string } & RelayDelay)
  | { type: "engineList"; engines: LanEngineInfo[] };

export type ClientRelayMessage =
  | { type: "ping" }
  | { type: "getEngineList" }
  | { type: "startEngine"; engineId: string }
  | { type: "stopEngine" }
  | { type: "usi"; command: string };

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ENGINE_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;
export const MIN_MULTIPV = 1;
export const MAX_MULTIPV = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRelayState = (value: unknown): value is RelayState =>
  typeof value === "string" && (RELAY_STATES as readonly string[]).includes(value);

const isActiveRelayState = (value: RelayState): value is ActiveRelayState =>
  value === "starting" || value === "ready" || value === "thinking";

export const isLanEngineType = (value: unknown): value is LanEngineType =>
  typeof value === "string" && (LAN_ENGINE_TYPES as readonly string[]).includes(value);

export const isRelayEngineId = (value: unknown): value is string =>
  typeof value === "string" && ENGINE_ID_PATTERN.test(value);

const isValidDelay = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const decodeDelay = (value: unknown): DecodeResult<number | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isValidDelay(value)) return { ok: false, error: "invalid relay delay" };
  return { ok: true, value };
};

const withDelay = <T extends object>(value: T, delay: number | undefined): T & RelayDelay =>
  delay === undefined ? value : { ...value, delay };

export const decodeLanEngineInfo = (value: unknown): DecodeResult<LanEngineInfo> => {
  if (!isRecord(value) || !isRelayEngineId(value.id) || typeof value.name !== "string") {
    return { ok: false, error: "invalid engine summary" };
  }
  if (value.type !== undefined) {
    if (!Array.isArray(value.type) || !value.type.every(isLanEngineType)) {
      return { ok: false, error: "invalid engine type" };
    }
    return {
      ok: true,
      value: { id: value.id, name: value.name, type: [...value.type] },
    };
  }
  return { ok: true, value: { id: value.id, name: value.name } };
};

const NOTICE_BY_INFO: Record<string, RelayNotice> = {
  pong: "pong",
  "info: engine is ready": "engineReady",
  "info: engine stopped": "engineStopped",
};

const INFO_BY_NOTICE: Record<RelayNotice, string> = {
  pong: "pong",
  engineReady: "info: engine is ready",
  engineStopped: "info: engine stopped",
};

export const decodeServerRelayMessage = (data: unknown): DecodeResult<ServerRelayMessage> => {
  if (typeof data !== "string") {
    return { ok: false, error: "relay frame must be text" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, error: "relay frame is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "relay frame must be an object" };
  }

  const primaryKeys = ["state", "error", "info", "engineList"].filter((key) =>
    Object.hasOwn(parsed, key),
  );
  if (primaryKeys.length !== 1) {
    return { ok: false, error: "relay frame must contain exactly one payload" };
  }

  if (primaryKeys[0] === "engineList") {
    if (!Array.isArray(parsed.engineList)) {
      return { ok: false, error: "invalid engine list" };
    }
    const engines: LanEngineInfo[] = [];
    for (const item of parsed.engineList) {
      const result = decodeLanEngineInfo(item);
      if (!result.ok) return result;
      engines.push(result.value);
    }
    return { ok: true, value: { type: "engineList", engines } };
  }

  const delayResult = decodeDelay(parsed.delay);
  if (!delayResult.ok) return delayResult;
  const delay = delayResult.value;

  if (primaryKeys[0] === "state") {
    if (!isRelayState(parsed.state) || !Object.hasOwn(parsed, "engineId")) {
      return { ok: false, error: "invalid relay state" };
    }
    if (isActiveRelayState(parsed.state)) {
      if (!isRelayEngineId(parsed.engineId)) {
        return { ok: false, error: "active state requires an engine id" };
      }
      return {
        ok: true,
        value: withDelay({ type: "state", state: parsed.state, engineId: parsed.engineId }, delay),
      };
    }
    if (parsed.engineId !== null) {
      return { ok: false, error: "inactive state requires a null engine id" };
    }
    return {
      ok: true,
      value: withDelay({ type: "state", state: parsed.state, engineId: null }, delay),
    };
  }

  if (primaryKeys[0] === "error") {
    if (typeof parsed.error !== "string") {
      return { ok: false, error: "invalid relay error" };
    }
    return {
      ok: true,
      value: withDelay({ type: "error", message: parsed.error }, delay),
    };
  }

  if (typeof parsed.info !== "string") {
    return { ok: false, error: "invalid relay info" };
  }
  if (Object.hasOwn(parsed, "sfen")) {
    if (parsed.sfen !== null && typeof parsed.sfen !== "string") {
      return { ok: false, error: "invalid engine output position" };
    }
    return {
      ok: true,
      value: withDelay(
        { type: "engineOutput", positionCommand: parsed.sfen, output: parsed.info },
        delay,
      ),
    };
  }
  if (!Object.hasOwn(NOTICE_BY_INFO, parsed.info)) {
    return { ok: false, error: "unknown relay notice" };
  }
  const notice = NOTICE_BY_INFO[parsed.info];
  return { ok: true, value: withDelay({ type: "notice", notice }, delay) };
};

const assertValidDelay = (delay: number): void => {
  if (!isValidDelay(delay)) throw new Error("invalid relay delay");
};

export const encodeSessionRelayMessage = (payload: SessionRelayPayload, delay: number): string => {
  assertValidDelay(delay);
  switch (payload.type) {
    case "state":
      return JSON.stringify({ state: payload.state, engineId: payload.engineId, delay });
    case "engineOutput":
      return JSON.stringify({ sfen: payload.positionCommand, info: payload.output, delay });
    case "notice":
      return JSON.stringify({ info: INFO_BY_NOTICE[payload.notice], delay });
    case "error":
      return JSON.stringify({ error: payload.message, delay });
  }
};

export const encodeEngineListRelayMessage = (engines: LanEngineInfo[]): string =>
  JSON.stringify({ engineList: engines });

export const isValidUsiCommand = (command: unknown): command is string => {
  if (typeof command !== "string" || /[\r\n]/.test(command)) return false;

  const cmd = command.trim();
  if (cmd === "") return false;
  const parts = cmd.split(" ");
  const head = parts[0];

  switch (head) {
    case "usi":
    case "isready":
    case "usinewgame":
    case "stop":
    case "ponderhit":
    case "quit":
      return parts.length === 1;
    case "gameover":
      return parts.length === 2 && ["win", "lose", "draw"].includes(parts[1]);
    case "setoption": {
      const match = /^setoption name MultiPV value (\d+)$/.exec(cmd);
      if (!match) return false;
      const value = Number(match[1]);
      return Number.isSafeInteger(value) && value >= MIN_MULTIPV && value <= MAX_MULTIPV;
    }
    case "position":
      if (parts[1] === "startpos") {
        if (parts.length === 2) return true;
        return (
          parts[2] === "moves" && parts.slice(3).every((move) => /^[a-zA-Z0-9+*]+$/.test(move))
        );
      }
      if (parts[1] === "sfen") {
        const movesIndex = parts.indexOf("moves");
        if (movesIndex === -1) {
          return /^position sfen [a-zA-Z0-9+/ -]+$/.test(cmd);
        }
        const sfenPart = parts.slice(0, movesIndex).join(" ");
        return (
          /^position sfen [a-zA-Z0-9+/ -]+$/.test(sfenPart) &&
          parts.slice(movesIndex + 1).every((move) => /^[a-zA-Z0-9+*]+$/.test(move))
        );
      }
      return false;
    case "go": {
      const args = parts.slice(1);
      for (let index = 0; index < args.length; index++) {
        const token = args[index];
        if (["ponder", "infinite"].includes(token)) continue;
        if (token === "mate") {
          if (index + 1 < args.length && /^(\d+|infinite)$/.test(args[index + 1])) {
            index++;
          }
          continue;
        }
        if (["btime", "wtime", "byoyomi", "binc", "winc"].includes(token)) {
          if (index + 1 >= args.length || !/^-?\d+$/.test(args[index + 1])) return false;
          index++;
          continue;
        }
        return false;
      }
      return true;
    }
    default:
      return false;
  }
};

export const decodeClientRelayMessage = (data: unknown): DecodeResult<ClientRelayMessage> => {
  if (typeof data !== "string" || /[\r\n]/.test(data)) {
    return { ok: false, error: "relay command must be one line of text" };
  }
  const command = data.trim();
  if (command === "ping") return { ok: true, value: { type: "ping" } };
  if (command === "get_engine_list") return { ok: true, value: { type: "getEngineList" } };
  if (command === "stop_engine") return { ok: true, value: { type: "stopEngine" } };
  if (command.startsWith("start_engine ")) {
    const engineId = command.substring("start_engine ".length).trim();
    return isRelayEngineId(engineId)
      ? { ok: true, value: { type: "startEngine", engineId } }
      : { ok: false, error: "invalid engine id" };
  }
  if (!isValidUsiCommand(command)) {
    return { ok: false, error: "invalid relay command" };
  }
  return { ok: true, value: { type: "usi", command } };
};

export const encodeClientRelayMessage = (message: ClientRelayMessage): string => {
  if (!isRecord(message) || !Object.hasOwn(message, "type")) {
    throw new Error("invalid client relay message");
  }
  switch (message.type) {
    case "ping":
      return "ping";
    case "getEngineList":
      return "get_engine_list";
    case "startEngine":
      if (!Object.hasOwn(message, "engineId") || !isRelayEngineId(message.engineId)) {
        throw new Error("invalid engine id");
      }
      return `start_engine ${message.engineId}`;
    case "stopEngine":
      return "stop_engine";
    case "usi":
      if (!Object.hasOwn(message, "command") || !isValidUsiCommand(message.command)) {
        throw new Error("invalid USI command");
      }
      return message.command.trim();
    default:
      throw new Error("invalid client relay message");
  }
};
