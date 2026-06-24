export type Point = [number, number];
export type Float32Array2D = Float32Array[];

export interface BoardDetection {
  corners: [Point, Point, Point, Point];
  confidence: number;
  warnings: VisionWarning[];
}

export interface VisionWarning {
  code: string;
  message: string;
  square?: string;
}

export interface RecognizedCell {
  piece: string | null;
  confidence: number;
  candidates: CellCandidate[];
  figureProbabilities?: number[];
  directionProbabilities?: number[];
}

export interface CellCandidate {
  piece: string | null;
  confidence: number;
}

export interface VisionResponse {
  ok: true;
  sfen: string;
  confidence: number;
  candidates: VisionCandidate[];
  warnings: VisionWarning[];
  board?: VisionCell[][];
}

export interface VisionCandidate {
  sfen: string;
  score: number;
  violations: VisionWarning[];
}

export interface VisionCell {
  square: string;
  piece: string | null;
  confidence: number;
  candidates: CellCandidate[];
}

export type SideToMove = "black" | "white";

export interface HandOwnerCounts {
  black: Record<string, number>;
  white: Record<string, number>;
}

export interface LetterboxInfo {
  gain: number;
  padding: [number, number];
  resizedShape: [number, number];
}

export interface RawImage {
  width: number;
  height: number;
  data: Uint8Array;
}
