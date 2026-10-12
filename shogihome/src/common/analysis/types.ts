import { Language } from "@/common/i18n/languages";
import type { AccuracySettings } from "@/common/game/score";
import type { AnalysisSettings } from "@/common/settings/analysis";
import { CommentBehavior, SearchCommentFormat } from "@/common/settings/comment";
import {
  isRelayEngineId,
  isValidUsiCommand,
  isValidMultiPV,
  MIN_MULTIPV,
  MAX_MULTIPV,
  type DecodeResult,
} from "@/common/engine/relay_protocol";
import { parseUSIMove } from "tsshogi";
import { parseInfoCommand, type USIInfoCommand } from "@/common/game/usi";
import {
  decodeRecordSnapshot,
  readSearchInfo,
  MAX_SNAPSHOT_PV,
  MAX_SNAPSHOT_NODES,
  type RecordSnapshot,
  type SearchInfoSnapshot,
} from "@/common/record/snapshot";
import * as v from "./validation";
import { readJobAttachment, type JobAttachmentState } from "@/common/jobs/types";
import {
  readBatchProgress,
  type BatchAnalysisProgress,
  type BatchAnalysisJobRequest,
  MAX_BATCH_FILES,
} from "./batch";

export const DEFAULT_ANALYSIS_POLL_MS = 1000;

export const ANALYSIS_JOB_STATES = [
  "preparing",
  "running",
  "finishing",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
] as const;
export type AnalysisJobState = (typeof ANALYSIS_JOB_STATES)[number];
export const ANALYSIS_JOB_ERRORS = [
  "engine",
  "expired",
  "capacity",
  "invalid",
  "deadline",
] as const;
export type AnalysisJobError = (typeof ANALYSIS_JOB_ERRORS)[number];
export type AnalysisJobOptions = Omit<AnalysisSettings, "usi"> & {
  engineId: string;
  engineTimeoutSeconds: number;
  accuracy: AccuracySettings;
  commentFormat: SearchCommentFormat;
  language: Language;
};
export type AnalysisJobRequest = {
  requestId: string;
  serverInstanceId: string;
  source: RecordSnapshot;
  options: AnalysisJobOptions;
};
export type AnalysisCapabilities = {
  serverInstanceId: string;
  pollMs: number;
  maxInputBytes: number;
  maxNodes: number;
};
export type AnalysisJobStatus = {
  attachment?: JobAttachmentState;
  jobId: string;
  requestId: string;
  serverInstanceId: string;
  state: AnalysisJobState;
  engineName: string;
  completedPositions: number;
  totalPositions: number;
  resultRevision: number;
  current: { nodeId: string; searchId: number; position: string; infos: USIInfoCommand[] } | null;
  error?: AnalysisJobError;
  batch?: BatchAnalysisProgress;
};
export type AnalysisNodeResult = {
  id: string;
  revision: number;
  comment: string;
  researchInfo?: SearchInfoSnapshot;
};
export type AnalysisJobResult = {
  attachment?: JobAttachmentState;
  jobId: string;
  serverInstanceId: string;
  revision: number;
  nodes: AnalysisNodeResult[];
  recordIndex?: number;
};

export function isAnalysisTerminal(state: AnalysisJobState): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

function decoded<T>(fn: () => T): DecodeResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid analysis payload",
    };
  }
}

export function decodeAnalysisJobRequest(value: unknown): DecodeResult<AnalysisJobRequest> {
  return decoded(() => {
    const input = v.object(value);
    const source = decodeRecordSnapshot(input.source);
    if (!source.ok) throw new Error(source.error);
    return {
      requestId: v.identifier(input.requestId),
      serverInstanceId: v.identifier(input.serverInstanceId),
      source: source.value,
      options: readAnalysisOptions(input.options),
    };
  });
}

export function readAnalysisOptions(value: unknown): AnalysisJobOptions {
  const options = v.object(value);
  const engineId = v.text(options.engineId, 100);
  if (!isRelayEngineId(engineId)) throw new Error("Invalid engine ID");
  const criteria = (value: unknown) => {
    const input = v.object(value);
    const enableNumber = v.boolean(input.enableNumber);
    const number = v.counter(input.number);
    if (enableNumber && number === 0) throw new Error("Invalid move number");
    return { enableNumber, number };
  };
  const startCriteria = criteria(options.startCriteria);
  const endCriteria = criteria(options.endCriteria);
  if (
    startCriteria.enableNumber &&
    endCriteria.enableNumber &&
    startCriteria.number > endCriteria.number
  )
    throw new Error("Invalid analysis range");
  const accuracy = v.object(options.accuracy);
  const thresholds = [
    accuracy.badMoveLevelThreshold1,
    accuracy.badMoveLevelThreshold2,
    accuracy.badMoveLevelThreshold3,
    accuracy.badMoveLevelThreshold4,
  ].map((value) => v.finite(value, 1, 100));
  if (thresholds.some((value, index) => index > 0 && value <= thresholds[index - 1]))
    throw new Error("Invalid accuracy thresholds");
  const overrideMultiPV =
    options.overrideMultiPV === undefined ? false : v.boolean(options.overrideMultiPV);
  if (overrideMultiPV && !isValidMultiPV(options.multiPV)) throw new Error("Invalid MultiPV");
  return {
    engineId,
    engineTimeoutSeconds: v.finite(options.engineTimeoutSeconds, 1, 300),
    startCriteria,
    endCriteria,
    descending: v.boolean(options.descending),
    perMoveCriteria: {
      maxSeconds: v.finite(v.object(options.perMoveCriteria).maxSeconds, 0, 3600),
    },
    overrideMultiPV,
    multiPV: isValidMultiPV(options.multiPV) ? options.multiPV : MIN_MULTIPV,
    commentBehavior: v.enumeration(options.commentBehavior, Object.values(CommentBehavior)),
    commentFormat: v.enumeration(options.commentFormat, Object.values(SearchCommentFormat)),
    language: v.enumeration(options.language, Object.values(Language)),
    accuracy: {
      coefficientInSigmoid: v.finite(accuracy.coefficientInSigmoid, Number.MIN_VALUE),
      badMoveLevelThreshold1: thresholds[0],
      badMoveLevelThreshold2: thresholds[1],
      badMoveLevelThreshold3: thresholds[2],
      badMoveLevelThreshold4: thresholds[3],
    },
  };
}

export function decodeBatchJobRequest(value: unknown): DecodeResult<BatchAnalysisJobRequest> {
  return decoded(() => {
    const input = v.object(value);
    const file = v.object(input.fileOptions);
    return {
      requestId: v.identifier(input.requestId),
      serverInstanceId: v.identifier(input.serverInstanceId),
      planId: v.identifier(input.planId),
      options: readAnalysisOptions(input.options),
      skipAnalyzed: v.boolean(input.skipAnalyzed),
      fileOptions: {
        autoDetect: v.boolean(file.autoDetect),
        returnCode: v.enumeration(file.returnCode, ["\n", "\r\n"]),
        useCSAV3: v.boolean(file.useCSAV3),
        useUTF8ForKifAndKi2: v.boolean(file.useUTF8ForKifAndKi2),
      },
    };
  });
}

export function readUSIInfo(value: unknown): USIInfoCommand {
  const input = v.object(value);
  const result: USIInfoCommand = {};
  for (const key of [
    "depth",
    "seldepth",
    "timeMs",
    "nodes",
    "hashfullPerMill",
    "nps",
    "scoreCP",
    "scoreMate",
  ] as const) {
    if (input[key] !== undefined)
      result[key] = v.finite(
        input[key],
        key === "scoreCP" || key === "scoreMate" ? -Number.MAX_SAFE_INTEGER : 0,
      );
  }
  if (input.multipv !== undefined) {
    if (!isValidMultiPV(input.multipv)) throw new Error("Invalid MultiPV");
    result.multipv = input.multipv;
  }
  for (const key of ["lowerbound", "upperbound"] as const)
    if (input[key] !== undefined) result[key] = v.boolean(input[key]);
  if (
    (result.lowerbound && result.upperbound) ||
    ((result.lowerbound || result.upperbound) &&
      result.scoreCP === undefined &&
      result.scoreMate === undefined)
  )
    throw new Error("Invalid score bound");
  if (input.pv !== undefined)
    result.pv = v.array(input.pv, MAX_SNAPSHOT_PV).map((value) => {
      const move = v.text(value, 5);
      if (!parseUSIMove(move)) throw new Error("Invalid PV");
      return move;
    });
  if (input.currmove !== undefined) {
    result.currmove = v.text(input.currmove, 5);
    if (!parseUSIMove(result.currmove)) throw new Error("Invalid current move");
  }
  if (input.string !== undefined) result.string = v.text(input.string, 4096);
  return result;
}

export function parseAnalysisInfo(line: string): USIInfoCommand | null {
  if (!line.startsWith("info ")) return null;
  try {
    const info = parseInfoCommand(line);
    if (info.pv) info.pv = info.pv.slice(0, MAX_SNAPSHOT_PV);
    if (info.string) info.string = info.string.substring(0, 4096);
    return readUSIInfo(info);
  } catch {
    return null;
  }
}

export function decodeAnalysisStatus(value: unknown): DecodeResult<AnalysisJobStatus> {
  return decoded(() => {
    const input = v.object(value);
    const totalPositions = v.counter(input.totalPositions, MAX_SNAPSHOT_NODES);
    let current: AnalysisJobStatus["current"] = null;
    if (input.current !== null) {
      const data = v.object(input.current);
      const position = v.text(data.position, 32_768);
      if (!position.startsWith("position ") || !isValidUsiCommand(position))
        throw new Error("Invalid position");
      current = {
        nodeId: v.identifier(data.nodeId),
        searchId: v.counter(data.searchId),
        position,
        infos: v.array(data.infos, MAX_MULTIPV).map(readUSIInfo),
      };
      if (current.searchId === 0) throw new Error("Invalid search ID");
    }
    return {
      jobId: v.identifier(input.jobId),
      requestId: v.identifier(input.requestId),
      serverInstanceId: v.identifier(input.serverInstanceId),
      state: v.enumeration(input.state, ANALYSIS_JOB_STATES),
      engineName: v.text(input.engineName, 1024),
      totalPositions,
      completedPositions: v.counter(input.completedPositions, totalPositions),
      resultRevision: v.counter(input.resultRevision),
      ...(input.attachment === undefined
        ? {}
        : { attachment: readJobAttachment(input.attachment) }),
      current,
      ...(input.batch === undefined ? {} : { batch: readBatchProgress(input.batch) }),
      ...(input.error === undefined
        ? {}
        : { error: v.enumeration(input.error, ANALYSIS_JOB_ERRORS) }),
    };
  });
}

export function decodeAnalysisResult(value: unknown): DecodeResult<AnalysisJobResult> {
  return decoded(() => {
    const input = v.object(value);
    const revision = v.counter(input.revision);
    const ids = new Set<string>();
    return {
      ...(input.attachment === undefined
        ? {}
        : { attachment: readJobAttachment(input.attachment) }),
      jobId: v.identifier(input.jobId),
      serverInstanceId: v.identifier(input.serverInstanceId),
      revision,
      ...(input.recordIndex === undefined
        ? {}
        : { recordIndex: v.counter(input.recordIndex, MAX_BATCH_FILES) }),
      nodes: v.array(input.nodes, MAX_SNAPSHOT_NODES).map((value) => {
        const node = v.object(value);
        const id = v.identifier(node.id);
        if (ids.has(id)) throw new Error("Duplicate result node");
        ids.add(id);
        return {
          id,
          revision: v.counter(node.revision, revision),
          comment: v.text(node.comment),
          ...(node.researchInfo === undefined
            ? {}
            : { researchInfo: readSearchInfo(node.researchInfo) }),
        };
      }),
    };
  });
}

export function decodeAnalysisCapabilities(value: unknown): DecodeResult<AnalysisCapabilities> {
  return decoded(() => {
    const input = v.object(value);
    return {
      serverInstanceId: v.identifier(input.serverInstanceId),
      pollMs: v.finite(input.pollMs, 100, 60_000),
      maxInputBytes: v.counter(input.maxInputBytes),
      maxNodes: v.counter(input.maxNodes),
    };
  });
}
