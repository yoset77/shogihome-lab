import type { VisionResponse } from "./types.js";
import { loadImage } from "./image-io.js";
import { detectBoard } from "./board-detector.js";
import { removePerspective, splitCells } from "./board-splitter.js";
import { recognizeBoard } from "./recognizer.js";
import { buildHandRegions, detectHandPieces } from "./hand-detector.js";
import { assemblePosition } from "./postprocess.js";

export interface ScanOptions {
  imagePath: string;
  sideToMove: "black" | "white";
  maxCandidates: number;
  modelDir: string;
}

export const scanImage = async (options: ScanOptions): Promise<VisionResponse> => {
  const { imagePath, sideToMove, maxCandidates, modelDir } = options;

  const image = await loadImage(imagePath);

  const detection = await detectBoard(image, modelDir);

  const boardImage = removePerspective(image, detection.corners);

  const cells = splitCells(boardImage);

  const recognized = await recognizeBoard(cells, modelDir);

  const handRegions = buildHandRegions(image, detection.corners);
  const ownerCounts = await detectHandPieces(handRegions, modelDir);
  const handCounts: Record<string, number> = {};
  for (const [piece, count] of Object.entries(ownerCounts.black)) {
    handCounts[piece] = count;
  }
  for (const [piece, count] of Object.entries(ownerCounts.white)) {
    handCounts[piece] = count;
  }

  const response = assemblePosition(
    recognized,
    sideToMove,
    detection.warnings,
    Object.keys(handCounts).length > 0 ? handCounts : null,
  );

  response.candidates = response.candidates.slice(0, maxCandidates);

  return response;
};
