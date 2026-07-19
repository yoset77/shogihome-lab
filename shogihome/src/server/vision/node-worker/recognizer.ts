import type { RecognizedCell, RawImage, CellCandidate } from "./types.js";
import { loadSession, createTensor } from "./session.js";
import path from "node:path";

const FIGURE_LABELS = [
  "P",
  "B",
  "R",
  "L",
  "N",
  "S",
  "G",
  "K",
  null,
  "+P",
  "+L",
  "+N",
  "+S",
  "+B",
  "+R",
];
const DIRECTION_LABELS = ["up", "down", "none"];
const DEFAULT_MODEL = "mixed.onnx";

export const recognizeBoard = async (
  cells: RawImage[][],
  modelDir: string,
): Promise<RecognizedCell[][]> => {
  const modelPath = path.join(modelDir, DEFAULT_MODEL);
  const session = await loadSession(modelPath);
  const inputName = session.inputNames[0];
  const outputNames = session.outputNames;

  const batchSize = 81;
  const imageSize = 64;
  const input = new Float32Array(batchSize * imageSize * imageSize);

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const idx = row * 9 + col;
      const cell = cells[row][col];
      const resized = resizeGrayscale(cell, imageSize, imageSize);
      for (let k = 0; k < resized.length; k++) {
        resized[k] /= 255.0;
      }
      input.set(resized, idx * imageSize * imageSize);
    }
  }

  const tensor = createTensor(inputName, input, [batchSize, imageSize, imageSize, 1]);
  const results = await session.run({ [inputName]: tensor });

  const figureData = results[outputNames[0]].data as Float32Array;
  const directionData = results[outputNames[1]].data as Float32Array;

  const recognized: RecognizedCell[][] = [];
  for (let row = 0; row < 9; row++) {
    const rowCells: RecognizedCell[] = [];
    for (let col = 0; col < 9; col++) {
      const idx = row * 9 + col;
      const figureProbs = ensureProbabilities(extractRow(figureData, idx, FIGURE_LABELS.length));
      const directionProbs = ensureProbabilities(
        extractRow(directionData, idx, DIRECTION_LABELS.length),
      );
      rowCells.push(cellFromPredictions(figureProbs, directionProbs));
    }
    recognized.push(rowCells);
  }

  return recognized;
};

const extractRow = (data: Float32Array, row: number, cols: number): Float32Array => {
  const result = new Float32Array(cols);
  for (let i = 0; i < cols; i++) {
    result[i] = data[row * cols + i];
  }
  return result;
};

const softmax = (values: Float32Array): Float32Array => {
  const maxVal = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - maxVal));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
};

const ensureProbabilities = (values: Float32Array): Float32Array => {
  let allNonNegative = true;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < 0) {
      allNonNegative = false;
      break;
    }
  }

  if (allNonNegative) {
    let rowSum = 0;
    for (let i = 0; i < values.length; i++) {
      rowSum += values[i];
    }
    if (Math.abs(rowSum - 1.0) < 1e-3) {
      return values;
    }
  }

  return softmax(values);
};

export const cellFromPredictions = (
  figureProbs: Float32Array,
  directionProbs: Float32Array,
): RecognizedCell => {
  const candidates = buildCandidates(figureProbs, directionProbs, 5);
  const best = candidates[0] ?? { piece: null, confidence: 1 };

  return { piece: best.piece, confidence: best.confidence, candidates };
};

const orientedPiece = (piece: string | null, direction: string): string | null => {
  if (piece === null) return null;
  if (direction === "down") {
    return piece.startsWith("+") ? "+" + piece[1].toLowerCase() : piece.toLowerCase();
  }
  if (direction === "none") return null;
  return piece;
};

const buildCandidates = (
  figureProbs: Float32Array,
  directionProbs: Float32Array,
  limit: number,
): CellCandidate[] => {
  const probabilityByPiece = new Map<string | null, number>();
  for (let fi = 0; fi < FIGURE_LABELS.length; fi++) {
    const figure = FIGURE_LABELS[fi];
    for (let di = 0; di < DIRECTION_LABELS.length; di++) {
      const direction = DIRECTION_LABELS[di];
      if ((figure === null) !== (direction === "none")) continue;
      const piece = orientedPiece(figure, direction);
      const prob = figureProbs[fi] * directionProbs[di];
      probabilityByPiece.set(piece, (probabilityByPiece.get(piece) ?? 0) + prob);
    }
  }

  const total = [...probabilityByPiece.values()].reduce((sum, probability) => sum + probability, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return [{ piece: null, confidence: 1 }];
  }

  const allCandidates = [...probabilityByPiece.entries()]
    .filter(([, probability]) => probability > 0)
    .map(([piece, probability]) => ({ piece, confidence: probability / total }))
    .sort((a, b) => b.confidence - a.confidence);
  const candidates = allCandidates.slice(0, limit);
  const emptyProbability = probabilityByPiece.get(null);
  const emptyCandidate =
    emptyProbability === undefined
      ? undefined
      : { piece: null, confidence: emptyProbability / total };
  if (limit > 1 && emptyCandidate && !candidates.some((candidate) => candidate.piece === null)) {
    if (candidates.length === limit) {
      candidates[candidates.length - 1] = emptyCandidate;
    } else {
      candidates.push(emptyCandidate);
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
  }
  return candidates;
};

const resizeGrayscale = (image: RawImage, targetW: number, targetH: number): Float32Array => {
  const srcW = image.width;
  const srcH = image.height;
  const dst = new Float32Array(targetW * targetH);

  for (let dy = 0; dy < targetH; dy++) {
    for (let dx = 0; dx < targetW; dx++) {
      const sx = Math.max(0, Math.min(((dx + 0.5) * srcW) / targetW - 0.5, srcW - 1));
      const sy = Math.max(0, Math.min(((dy + 0.5) * srcH) / targetH - 0.5, srcH - 1));
      const x0 = Math.min(Math.floor(sx), srcW - 1);
      const y0 = Math.min(Math.floor(sy), srcH - 1);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const v00 = grayscaleAt(image, x0, y0);
      const v10 = grayscaleAt(image, x1, y0);
      const v01 = grayscaleAt(image, x0, y1);
      const v11 = grayscaleAt(image, x1, y1);
      dst[dy * targetW + dx] =
        v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  }

  return dst;
};

const grayscaleAt = (image: RawImage, x: number, y: number): number => {
  const idx = (y * image.width + x) * 4;
  return image.data[idx] * 0.299 + image.data[idx + 1] * 0.587 + image.data[idx + 2] * 0.114;
};
