import type { AnalysisJobOptions } from "./types";
import type { DecodeResult } from "@/common/engine/relay_protocol";
import type { KifuSearchQuery } from "@/common/file/sfen_export";
import { searchableStrategies, UNCLASSIFIED_STRATEGY } from "@/common/kifu/strategy_taxonomy";
import { normalizeSfen } from "@/common/usi/sfen";
import { Position } from "tsshogi";
import * as v from "./validation";

export const MAX_BATCH_FILES = 10_000;
export type BatchAnalysisSource =
  | { kind: "folder"; directory: string; subdirectories: boolean }
  | { kind: "search"; search: KifuSearchQuery };
export type BatchAnalysisPlan = { planId: string; files: string[]; expiresAt: number };
export type BatchFileOptions = {
  autoDetect: boolean;
  returnCode: string;
  useCSAV3: boolean;
  useUTF8ForKifAndKi2: boolean;
};
export type BatchAnalysisJobRequest = {
  requestId: string;
  serverInstanceId: string;
  planId: string;
  options: AnalysisJobOptions;
  skipAnalyzed: boolean;
  fileOptions: BatchFileOptions;
};
export const BATCH_FILE_STATES = [
  "pending",
  "running",
  "saved",
  "failed",
  "skipped",
  "cancelled",
] as const;
export const BATCH_FILE_REASONS = [
  "read",
  "invalid",
  "save",
  "changed",
  "engine",
  "analyzed",
  "noPositions",
] as const;
export type BatchFileResult = {
  index: number;
  path: string;
  state: (typeof BATCH_FILE_STATES)[number];
  reason?: (typeof BATCH_FILE_REASONS)[number];
};
export type BatchAnalysisProgress = {
  totalFiles: number;
  processedFiles: number;
  currentFile: number;
  currentPath: string;
  recordIndex: number;
  recordPath: string;
  saved: boolean;
  successTotal: number;
  failedTotal: number;
  skippedTotal: number;
};

export function readBatchSource(value: unknown): BatchAnalysisSource {
  const input = v.object(value);
  if (input.kind === "folder")
    return {
      kind: "folder",
      directory: v.text(input.directory, 1024),
      subdirectories: v.boolean(input.subdirectories),
    };
  if (input.kind !== "search") throw new Error("Invalid batch source");
  const raw = v.object(input.search);
  const search: KifuSearchQuery = {};
  for (const key of ["keyword", "player1", "player2", "startDate"] as const)
    if (raw[key] !== undefined) search[key] = v.text(raw[key], 1024);
  if (raw.isStrictTurn !== undefined) search.isStrictTurn = v.boolean(raw.isStrictTurn);
  if (raw.sfen !== undefined) {
    search.sfen = normalizeSfen(v.text(raw.sfen, 1024));
    if (!Position.newBySFEN(`${search.sfen} 1`)) throw new Error("Invalid search position");
  }
  if (raw.strategy !== undefined)
    search.strategy = v.enumeration(raw.strategy, [...searchableStrategies, UNCLASSIFIED_STRATEGY]);
  return { kind: "search", search };
}
export function readBatchProgress(value: unknown): BatchAnalysisProgress {
  const input = v.object(value);
  const totalFiles = v.counter(input.totalFiles, MAX_BATCH_FILES);
  const successTotal = v.counter(input.successTotal, totalFiles);
  const failedTotal = v.counter(input.failedTotal, totalFiles);
  const skippedTotal = v.counter(input.skippedTotal, totalFiles);
  const processedFiles = v.counter(input.processedFiles, totalFiles);
  if (processedFiles !== successTotal + failedTotal + skippedTotal)
    throw new Error("Invalid batch counts");
  return {
    totalFiles,
    processedFiles,
    successTotal,
    failedTotal,
    skippedTotal,
    currentFile: v.counter(input.currentFile, totalFiles),
    currentPath: v.text(input.currentPath, 1024),
    recordIndex: v.counter(input.recordIndex, totalFiles),
    recordPath: v.text(input.recordPath, 1024),
    saved: v.boolean(input.saved),
  };
}
export function decodeBatchPlan(value: unknown): DecodeResult<BatchAnalysisPlan> {
  try {
    const input = v.object(value);
    const files = v.array(input.files, MAX_BATCH_FILES).map((value) => v.text(value, 1024));
    if (!files.length || new Set(files).size !== files.length)
      throw new Error("Invalid batch files");
    return {
      ok: true,
      value: { planId: v.identifier(input.planId), files, expiresAt: v.counter(input.expiresAt) },
    };
  } catch {
    return { ok: false, error: "Invalid batch plan" };
  }
}
export function decodeBatchFiles(value: unknown): DecodeResult<BatchFileResult[]> {
  try {
    return {
      ok: true,
      value: v.array(value, MAX_BATCH_FILES).map((value, offset) => {
        const input = v.object(value);
        const index = v.counter(input.index, MAX_BATCH_FILES);
        if (index !== offset + 1) throw new Error("Invalid file index");
        return {
          index,
          path: v.text(input.path, 1024),
          state: v.enumeration(input.state, BATCH_FILE_STATES),
          ...(input.reason === undefined
            ? {}
            : { reason: v.enumeration(input.reason, BATCH_FILE_REASONS) }),
        };
      }),
    };
  } catch {
    return { ok: false, error: "Invalid batch files" };
  }
}
