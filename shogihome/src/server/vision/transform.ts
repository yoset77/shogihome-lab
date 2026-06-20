import { flippedSFEN } from "@/common/helpers/sfen";
import type {
  VisionScanResponse,
  VisionTurn,
  VisionViewpoint,
  VisionWarning,
} from "@/common/vision/types";

type WorkerVisionScanResponse = VisionScanResponse & {
  board?: unknown;
};

export const transformVisionResponse = (
  response: WorkerVisionScanResponse,
  sideToMove: VisionTurn,
  viewpoint: VisionViewpoint,
): VisionScanResponse => {
  const normalized = stripInternalFields(response);
  if (viewpoint === "black") {
    return normalized;
  }
  return {
    ...normalized,
    sfen: flipSfenKeepingTurn(normalized.sfen, sideToMove),
    candidates: normalized.candidates.map((candidate) => ({
      ...candidate,
      sfen: flipSfenKeepingTurn(candidate.sfen, sideToMove),
      violations: candidate.violations.map(flipWarningSquare),
    })),
    warnings: normalized.warnings.map(flipWarningSquare),
  };
};

const stripInternalFields = (response: WorkerVisionScanResponse): VisionScanResponse => {
  const { ok, sfen, confidence, candidates, warnings, preview } = response;
  return preview
    ? { ok, sfen, confidence, candidates, warnings, preview }
    : { ok, sfen, confidence, candidates, warnings };
};

const flipSfenKeepingTurn = (sfen: string, sideToMove: VisionTurn): string => {
  const sections = flippedSFEN(sfen).split(" ");
  sections[1] = sideToMove === "black" ? "b" : "w";
  return sections.join(" ");
};

const flipWarningSquare = (warning: VisionWarning): VisionWarning => {
  if (!warning.square) {
    return warning;
  }
  return {
    ...warning,
    square: flipSquare(warning.square),
  };
};

const flipSquare = (square: string): string => {
  const file = square[0];
  const rank = square[1];
  const flippedFile = file >= "1" && file <= "9" ? String(10 - Number(file)) : file;
  if (!rank) {
    return flippedFile;
  }
  const rankCode = rank.charCodeAt(0);
  if (rankCode < 97 || rankCode > 105) {
    return `${flippedFile}${rank}`;
  }
  return `${flippedFile}${String.fromCharCode(202 - rankCode)}`;
};
