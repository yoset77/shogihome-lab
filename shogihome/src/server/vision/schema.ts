import { Position } from "tsshogi";
import type { VisionScanResponse } from "@/common/vision/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isVisionWarning = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.square === undefined || typeof value.square === "string")
  );
};

const isVisionCandidate = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    typeof value.sfen === "string" &&
    typeof value.score === "number" &&
    Array.isArray(value.violations) &&
    value.violations.every(isVisionWarning)
  );
};

export const parseVisionScanResponse = (value: unknown): VisionScanResponse => {
  if (!isVisionScanResponse(value)) {
    throw new Error("vision worker returned an invalid response shape");
  }
  if (!Position.newBySFEN(value.sfen)) {
    throw new Error(`vision worker returned invalid sfen: ${value.sfen}`);
  }
  for (const candidate of value.candidates) {
    if (!Position.newBySFEN(candidate.sfen)) {
      throw new Error(`vision worker returned invalid candidate sfen: ${candidate.sfen}`);
    }
  }
  return value;
};

const isVisionScanResponse = (value: unknown): value is VisionScanResponse => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.ok === true &&
    typeof value.sfen === "string" &&
    typeof value.confidence === "number" &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isVisionCandidate) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isVisionWarning)
  );
};
