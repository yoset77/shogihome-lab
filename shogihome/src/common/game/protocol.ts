import { Color, InitialPositionType, SpecialMoveType, parseUSIMove } from "tsshogi";
import * as v from "@/common/analysis/validation";
import { readUSIInfo } from "@/common/analysis/types";
import type { DecodeResult } from "@/common/engine/relay_protocol";
import {
  decodeRecordSnapshot,
  readSearchInfo,
  MAX_SNAPSHOT_NODES,
  MAX_SNAPSHOT_PLY,
  type RecordSnapshot,
  type SearchInfoSnapshot,
} from "@/common/record/snapshot";
import {
  JishogiRule,
  validateGameSettings,
  type GameSettings,
  type TimeLimitSettings,
} from "@/common/settings/game";
import {
  BookMoveSelectionRule,
  emptyUSIEngine,
  type USIEngineExtraBookConfig,
} from "@/common/settings/usi";
import type { PlayerSettings } from "@/common/settings/player";
import { SearchCommentFormat } from "@/common/settings/comment";
import { RecordFileFormat } from "@/common/file/record";
import { Language } from "@/common/i18n/languages";
import { ES_HUMAN, isLanEngineURI } from "@/common/uri";
import type { GameResults } from "./results";
import type { USIInfoCommand } from "./usi";
import { readJobAttachRequest, type JobAttachRequest } from "@/common/jobs/types";

export const GAME_STATES = [
  "preparing",
  "running",
  "paused",
  "takingBack",
  "finishing",
  "completed",
  "failed",
] as const;
export type GameSessionState = (typeof GAME_STATES)[number];
export const MAX_GAME_ERROR_MESSAGE_LENGTH = 2048;
export type GameError = "engine" | "capacity" | "save";
export type GameClock = { timeMs: number; byoyomiMs: number; elapsedMs: number; running: boolean };
export type GameClocks = { black: GameClock; white: GameClock };
export type GameSaveOptions = {
  directory: string;
  template: string;
  format: RecordFileFormat;
  returnCode: string;
  useCSAV3: boolean;
  useUTF8ForKifAndKi2: boolean;
};
export type GameSessionRequest = {
  requestId: string;
  serverInstanceId: string;
  controllerId: string;
  source: RecordSnapshot;
  settings: GameSettings;
  options: {
    engineTimeoutSeconds: number;
    commentFormat: SearchCommentFormat;
    language: Language;
    save: GameSaveOptions;
  };
};
export type GameRecordSummary = {
  gameId: string;
  state: "saved" | "unsaved" | "failed";
  path?: string;
};
export type GameSnapshot = {
  controllerGeneration: number;
  controllerRecoveryId?: string;
  controllerOwnerId?: string;
  sessionId: string;
  requestId: string;
  serverInstanceId: string;
  controllerEpoch: number;
  controllerConnectionId?: string;
  revision: number;
  recordRevision: number;
  sampleId: number;
  gameId: string;
  gameNumber: number;
  interactionId: number;
  state: GameSessionState;
  settings: GameSettings;
  record: RecordSnapshot;
  clocks: GameClocks;
  results: GameResults;
  canMove: boolean;
  canTakeback: boolean;
  supportsTakeback: boolean;
  lastMoveId: number;
  lastResult?: SpecialMoveType;
  error?: GameError;
  errorMessage?: string;
  records: GameRecordSummary[];
};
export type GameCommandAction =
  "move" | "resign" | "declare" | "takeback" | "interrupt" | "resume" | "annotate";
export type GameCommand = {
  screenId?: string;
  controllerGeneration?: number;
  recoveryId?: string;
  requestId: string;
  serverInstanceId: string;
  controllerId: string;
  controllerEpoch: number;
  gameId: string;
  interactionId: number;
  action: GameCommandAction;
  move?: string;
  nodeId?: string;
  annotation?: {
    slot: "researchInfo" | "researchInfo2" | "researchInfo3" | "researchInfo4";
    info: SearchInfoSnapshot;
  };
};
export type GameFrame =
  | { type: "snapshot"; value: GameSnapshot }
  | {
      type: "clock";
      sessionId: string;
      serverInstanceId: string;
      revision: number;
      sampleId: number;
      clocks: GameClocks;
      infos: {
        color: Color;
        name: string;
        position: string;
        searchId: number;
        info: USIInfoCommand;
      }[];
    };
export type GameHeartbeat = { type: "heartbeat"; controllerEpoch: number };
export type GameConnection = {
  connectionId: string;
  controllerEpoch: number;
  screenId: string;
  recoveryId: string;
};
export type GameRecoveryRequest = JobAttachRequest & { connectionId?: string };
export function readGameRecoveryRequest(value: unknown): GameRecoveryRequest {
  const input = v.object(value);
  return {
    ...readJobAttachRequest(input),
    ...(input.connectionId === undefined ? {} : { connectionId: v.identifier(input.connectionId) }),
  };
}
export type GameClientFrame = GameHeartbeat | { type: "annotation"; value: GameCommand };
export type GameCapabilities = {
  serverInstanceId: string;
  maxInputBytes: number;
  heartbeatMs: number;
};

function decoded<T>(read: () => T): DecodeResult<T> {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false, error: "Invalid game protocol" };
  }
}
function readTime(value: unknown): TimeLimitSettings {
  const input = v.object(value);
  return {
    timeSeconds: v.counter(input.timeSeconds, 86_400),
    byoyomi: v.counter(input.byoyomi, 3600),
    increment: v.counter(input.increment, 3600),
  };
}
function readBook(value: unknown): USIEngineExtraBookConfig {
  const input = v.object(value);
  const result: USIEngineExtraBookConfig = {
    enabled: v.boolean(input.enabled),
    filePath: v.text(input.filePath, 2048),
    moveSelectionRule: v.enumeration(input.moveSelectionRule, Object.values(BookMoveSelectionRule)),
    scoreTemperature: v.finite(input.scoreTemperature, Number.MIN_VALUE, 1_000_000),
  };
  for (const key of ["minEvalBlack", "minEvalWhite"] as const)
    if (input[key] !== undefined) result[key] = v.finite(input[key], -1_000_000, 1_000_000);
  for (const key of ["maxEvalDiff", "maxMoves", "ignoreRate", "bookDepthLimit"] as const)
    if (input[key] !== undefined)
      result[key] = v.counter(input[key], key === "ignoreRate" ? 100 : 1_000_000);
  if (result.enabled && !result.filePath.startsWith("server://"))
    throw new Error("Server book required");
  return result;
}
function readPlayer(value: unknown): PlayerSettings {
  const input = v.object(value);
  const uri = v.text(input.uri, 128);
  if (uri !== ES_HUMAN && !isLanEngineURI(uri)) throw new Error("Unsupported player");
  const name = v.text(input.name, 256);
  if (!name) throw new Error("Player name required");
  const extraBook = input.usi === undefined ? undefined : v.object(input.usi).extraBook;
  return {
    uri,
    name,
    ...(extraBook === undefined
      ? {}
      : { usi: { ...emptyUSIEngine(), extraBook: readBook(extraBook) } }),
  };
}
export function readGameSettings(value: unknown): GameSettings {
  const input = v.object(value);
  const result: GameSettings = {
    black: readPlayer(input.black),
    white: readPlayer(input.white),
    timeLimit: readTime(input.timeLimit),
    ...(input.whiteTimeLimit === undefined
      ? {}
      : { whiteTimeLimit: readTime(input.whiteTimeLimit) }),
    startPosition: v.enumeration(input.startPosition, [
      ...Object.values(InitialPositionType),
      "current",
      "list",
    ] as const),
    startPositionListFile: v.text(input.startPositionListFile, 2048),
    startPositionListOrder: v.enumeration(input.startPositionListOrder, ["sequential", "shuffle"]),
    ...(input.startPositionListPly === undefined
      ? {}
      : { startPositionListPly: v.counter(input.startPositionListPly, 2048) }),
    enableEngineTimeout: v.boolean(input.enableEngineTimeout),
    humanIsFront: v.boolean(input.humanIsFront),
    enableComment: v.boolean(input.enableComment),
    enableAutoSave: v.boolean(input.enableAutoSave),
    repeat: v.counter(input.repeat, 10_000),
    swapPlayers: v.boolean(input.swapPlayers),
    maxMoves: v.counter(input.maxMoves, 2047),
    jishogiRule: v.enumeration(input.jishogiRule, Object.values(JishogiRule)),
  };
  if (validateGameSettings(result)) throw new Error("Invalid game settings");
  if (result.startPosition === "list" && !result.startPositionListFile.startsWith("server://"))
    throw new Error("Server positions required");
  return result;
}
export function decodeGameRequest(value: unknown): DecodeResult<GameSessionRequest> {
  return decoded(() => {
    const input = v.object(value),
      options = v.object(input.options),
      save = v.object(options.save);
    const source = decodeRecordSnapshot(input.source);
    if (!source.ok) throw new Error(source.error);
    if (source.value.nodes.length > MAX_SNAPSHOT_NODES - MAX_SNAPSHOT_PLY)
      throw new Error("No game record capacity");
    const settings = readGameSettings(input.settings);
    const current = source.value.nodes.find((node) => node.id === source.value.currentId)!;
    if (
      settings.startPosition === "current" &&
      typeof current.move !== "string" &&
      current.move.type !== SpecialMoveType.START
    )
      throw new Error("Terminal starting node");
    if (
      settings.startPosition === "current" &&
      source.value.selectedPath.indexOf(current.id) >= MAX_SNAPSHOT_PLY
    )
      throw new Error("No termination capacity");
    return {
      requestId: v.identifier(input.requestId),
      serverInstanceId: v.identifier(input.serverInstanceId),
      controllerId: v.identifier(input.controllerId),
      source: source.value,
      settings,
      options: {
        engineTimeoutSeconds: v.finite(options.engineTimeoutSeconds, 1, 300),
        commentFormat: v.enumeration(options.commentFormat, Object.values(SearchCommentFormat)),
        language: v.enumeration(options.language, Object.values(Language)),
        save: {
          directory: v.text(save.directory, 2048),
          template: v.text(save.template, 1024),
          format: v.enumeration(
            save.format,
            Object.values(RecordFileFormat).filter((format) => format !== RecordFileFormat.SFEN),
          ),
          returnCode: v.enumeration(save.returnCode, ["\n", "\r\n"]),
          useCSAV3: v.boolean(save.useCSAV3),
          useUTF8ForKifAndKi2: v.boolean(save.useUTF8ForKifAndKi2),
        },
      },
    };
  });
}
export function decodeGameCommand(value: unknown): DecodeResult<GameCommand> {
  return decoded(() => {
    const input = v.object(value);
    const result: GameCommand = {
      ...(input.screenId === undefined ? {} : { screenId: v.identifier(input.screenId) }),
      ...(input.controllerGeneration === undefined
        ? {}
        : { controllerGeneration: v.counter(input.controllerGeneration) }),
      ...(input.recoveryId === undefined ? {} : { recoveryId: v.identifier(input.recoveryId) }),
      requestId: v.identifier(input.requestId),
      serverInstanceId: v.identifier(input.serverInstanceId),
      controllerId: v.identifier(input.controllerId),
      controllerEpoch: v.counter(input.controllerEpoch),
      gameId: v.identifier(input.gameId),
      interactionId: v.counter(input.interactionId),
      action: v.enumeration(input.action, [
        "move",
        "resign",
        "declare",
        "takeback",
        "interrupt",
        "resume",
        "annotate",
      ]),
    };
    if (result.action === "move") {
      result.move = v.text(input.move, 5);
      if (!parseUSIMove(result.move)) throw new Error("Invalid move");
    }
    if (result.action === "annotate") {
      const annotation = v.object(input.annotation);
      result.nodeId = v.identifier(input.nodeId);
      result.annotation = {
        slot: v.enumeration(annotation.slot, [
          "researchInfo",
          "researchInfo2",
          "researchInfo3",
          "researchInfo4",
        ]),
        info: readSearchInfo(annotation.info),
      };
    }
    return result;
  });
}
export function readClocks(value: unknown): GameClocks {
  const input = v.object(value);
  const read = (value: unknown): GameClock => {
    const clock = v.object(value);
    return {
      timeMs: v.finite(clock.timeMs, 0),
      byoyomiMs: v.finite(clock.byoyomiMs, 0),
      elapsedMs: v.finite(clock.elapsedMs, 0),
      running: v.boolean(clock.running),
    };
  };
  return { black: read(input.black), white: read(input.white) };
}
export function decodeGameSnapshot(value: unknown): DecodeResult<GameSnapshot> {
  return decoded(() => {
    const input = v.object(value),
      results = v.object(input.results);
    const record = decodeRecordSnapshot(input.record);
    if (!record.ok) throw new Error(record.error);
    const player = (value: unknown) => {
      const input = v.object(value);
      return {
        name: v.text(input.name, 256),
        win: v.counter(input.win),
        winBlack: v.counter(input.winBlack),
        winWhite: v.counter(input.winWhite),
      };
    };
    return {
      controllerGeneration: v.counter(input.controllerGeneration),
      ...(input.controllerRecoveryId === undefined
        ? {}
        : { controllerRecoveryId: v.identifier(input.controllerRecoveryId) }),
      ...(input.controllerOwnerId === undefined
        ? {}
        : { controllerOwnerId: v.identifier(input.controllerOwnerId) }),
      sessionId: v.identifier(input.sessionId),
      requestId: v.identifier(input.requestId),
      serverInstanceId: v.identifier(input.serverInstanceId),
      controllerEpoch: v.counter(input.controllerEpoch),
      ...(input.controllerConnectionId === undefined
        ? {}
        : { controllerConnectionId: v.identifier(input.controllerConnectionId) }),
      revision: v.counter(input.revision),
      recordRevision: v.counter(input.recordRevision),
      sampleId: v.counter(input.sampleId),
      gameId: v.identifier(input.gameId),
      gameNumber: v.counter(input.gameNumber),
      interactionId: v.counter(input.interactionId),
      state: v.enumeration(input.state, GAME_STATES),
      settings: readGameSettings(input.settings),
      record: record.value,
      clocks: readClocks(input.clocks),
      results: {
        player1: player(results.player1),
        player2: player(results.player2),
        draw: v.counter(results.draw),
        invalid: v.counter(results.invalid),
        total: v.counter(results.total),
      },
      canMove: v.boolean(input.canMove),
      canTakeback: v.boolean(input.canTakeback),
      supportsTakeback: v.boolean(input.supportsTakeback),
      lastMoveId: v.counter(input.lastMoveId),
      ...(input.lastResult === undefined
        ? {}
        : { lastResult: v.enumeration(input.lastResult, Object.values(SpecialMoveType)) }),
      ...(input.error === undefined
        ? {}
        : { error: v.enumeration(input.error, ["engine", "capacity", "save"] as const) }),
      ...(input.errorMessage === undefined
        ? {}
        : { errorMessage: v.text(input.errorMessage, MAX_GAME_ERROR_MESSAGE_LENGTH) }),
      records: v.array(input.records, 10_000).map((value) => {
        const item = v.object(value);
        return {
          gameId: v.identifier(item.gameId),
          state: v.enumeration(item.state, ["saved", "unsaved", "failed"] as const),
          ...(item.path === undefined ? {} : { path: v.text(item.path, 2048) }),
        };
      }),
    };
  });
}
export function decodeGameFrame(value: unknown): DecodeResult<GameFrame> {
  return decoded(() => {
    const input = v.object(value);
    if (input.type === "snapshot") {
      const snapshot = decodeGameSnapshot(input.value);
      if (!snapshot.ok) throw new Error(snapshot.error);
      return { type: "snapshot", value: snapshot.value };
    }
    if (input.type !== "clock") throw new Error("Invalid frame");
    return {
      type: "clock",
      sessionId: v.identifier(input.sessionId),
      serverInstanceId: v.identifier(input.serverInstanceId),
      revision: v.counter(input.revision),
      sampleId: v.counter(input.sampleId),
      clocks: readClocks(input.clocks),
      infos: v.array(input.infos, 32).map((value) => {
        const item = v.object(value);
        return {
          color: v.enumeration(item.color, Object.values(Color)),
          name: v.text(item.name, 256),
          position: v.text(item.position, 32_768),
          searchId: v.counter(item.searchId),
          info: readUSIInfo(item.info),
        };
      }),
    };
  });
}
export function decodeGameHeartbeat(value: unknown): DecodeResult<GameHeartbeat> {
  return decoded(() => {
    const input = v.object(value);
    if (input.type !== "heartbeat") throw new Error("Invalid heartbeat");
    return { type: "heartbeat", controllerEpoch: v.counter(input.controllerEpoch) };
  });
}
export function decodeGameConnection(value: unknown): DecodeResult<GameConnection> {
  return decoded(() => {
    const input = v.object(value);
    return {
      screenId: v.identifier(input.screenId),
      recoveryId: v.identifier(input.recoveryId),
      connectionId: v.identifier(input.connectionId),
      controllerEpoch: v.counter(input.controllerEpoch),
    };
  });
}
export function decodeGameClientFrame(value: unknown): DecodeResult<GameClientFrame> {
  return decoded(() => {
    const input = v.object(value);
    if (input.type === "heartbeat") {
      const decoded = decodeGameHeartbeat(value);
      if (!decoded.ok) throw new Error(decoded.error);
      return decoded.value;
    }
    if (input.type !== "annotation") throw new Error("Invalid client frame");
    const command = decodeGameCommand(input.value);
    if (!command.ok || command.value.action !== "annotate") throw new Error("Invalid annotation");
    return { type: "annotation", value: command.value };
  });
}
export function decodeGameCapabilities(value: unknown): DecodeResult<GameCapabilities> {
  return decoded(() => {
    const input = v.object(value);
    return {
      serverInstanceId: v.identifier(input.serverInstanceId),
      maxInputBytes: v.counter(input.maxInputBytes),
      heartbeatMs: v.counter(input.heartbeatMs, 60_000),
    };
  });
}
export function isGameTerminal(state: GameSessionState): boolean {
  return state === "completed" || state === "failed";
}
