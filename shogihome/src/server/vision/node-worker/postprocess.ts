import type {
  RecognizedCell,
  VisionResponse,
  VisionWarning,
  VisionCandidate,
  CellCandidate,
} from "./types.js";

const RANKS = "abcdefghi";
const PIECE_LIMITS: Record<string, number> = {
  P: 18,
  L: 4,
  N: 4,
  S: 4,
  G: 4,
  B: 2,
  R: 2,
  K: 2,
};
const PIECE_BASES = ["P", "L", "N", "S", "G", "B", "R", "K"] as const;
const PIECE_BASE_INDEX: Record<string, number> = Object.fromEntries(
  PIECE_BASES.map((piece, index) => [piece, index]),
);
const PROMOTED_TO_BASE: Record<string, string> = {
  "+P": "P",
  "+L": "L",
  "+N": "N",
  "+S": "S",
  "+B": "B",
  "+R": "R",
  "+p": "P",
  "+l": "L",
  "+n": "N",
  "+s": "S",
  "+b": "B",
  "+r": "R",
};
const BEAM_WIDTH = 300;
const MAX_POSITION_CANDIDATES = 5;
const MIN_PROBABILITY = 1e-9;

const VIOLATION_PENALTIES: Record<string, number> = {
  KING_COUNT_INVALID: 4.0,
  PIECE_COUNT_INVALID: 2.0,
  TOTAL_PIECE_COUNT_INVALID: 2.0,
  ILLEGAL_PAWN: 1.0,
  IMMOBILE_PIECE: 1.0,
  LOW_CONFIDENCE: 0.25,
  BOARD_NOT_FOUND: 0.25,
  INVALID_SFEN: 2.0,
  MISSING_HANDS: 0.0,
  WRAPPER_ERROR: 2.0,
};

interface BeamState {
  logLikelihood: number;
  tail: BeamNode | null;
  baseCounts: Uint8Array;
}

interface BeamNode {
  previous: BeamNode | null;
  cell: ScoredCell;
}

interface UnconstrainedBeamState {
  logLikelihood: number;
  tail: BeamNode | null;
}

interface ScoredCell {
  piece: string | null;
  confidence: number;
  logProb: number;
  base: string | null;
  baseIndex: number;
  candidates: CellCandidate[];
}

export const assemblePosition = (
  recognized: RecognizedCell[][],
  turn: "black" | "white",
  upstreamWarnings: VisionWarning[],
  handCounts: Record<string, number> | null,
): VisionResponse => {
  const limits = handCounts ? adjustedLimits(handCounts) : { ...PIECE_LIMITS };
  const candidates = buildPositionCandidates(recognized, turn, limits);
  const best = candidates[0];
  const totalWarnings = validateTotalPieces(best.recognized, handCounts);
  const warnings: VisionWarning[] = [...upstreamWarnings, ...best.warnings, ...totalWarnings];
  const handSfen = handCounts ? buildHandSfen(handCounts) : "-";
  const sfen = `${buildBoardSfen(best.recognized)} ${turn === "black" ? "b" : "w"} ${handSfen} 1`;

  const candidateList: VisionCandidate[] = candidates.map((c) => {
    const cTotal = validateTotalPieces(c.recognized, handCounts);
    const cWarnings: VisionWarning[] = [...upstreamWarnings, ...c.warnings, ...cTotal];
    return {
      sfen: `${buildBoardSfen(c.recognized)} ${turn === "black" ? "b" : "w"} ${handSfen} 1`,
      score: c.score,
      violations: cWarnings,
    };
  });

  return {
    ok: true,
    sfen,
    confidence: best.confidence,
    candidates: candidateList,
    warnings,
  };
};

const buildPositionCandidates = (
  recognized: RecognizedCell[][],
  turn: "black" | "white",
  pieceLimits: Record<string, number>,
): Array<{
  recognized: RecognizedCell[][];
  confidence: number;
  score: number;
  warnings: VisionWarning[];
}> => {
  const cellOptions = precomputeScoredCells(recognized);
  let beams: BeamState[] = [
    { logLikelihood: 0, tail: null, baseCounts: new Uint8Array(PIECE_BASES.length) },
  ];

  for (const options of cellOptions) {
    const expanded: BeamState[] = [];
    for (const beam of beams) {
      for (const option of options) {
        const next = appendConstrainedOption(beam, option, pieceLimits);
        if (next) expanded.push(next);
      }
    }
    if (expanded.length === 0) {
      return buildUnconstrainedCandidates(recognized, turn);
    }
    beams = expanded.sort((a, b) => b.logLikelihood - a.logLikelihood).slice(0, BEAM_WIDTH);
  }

  const candidates: Array<{
    recognized: RecognizedCell[][];
    confidence: number;
    score: number;
    warnings: VisionWarning[];
  }> = [];
  const seen = new Set<string>();
  for (const beam of beams) {
    const board = toBoardFromScored(cellsFromBeam(beam.tail));
    const boardSfen = buildBoardSfen(board);
    if (seen.has(boardSfen)) continue;
    seen.add(boardSfen);
    const warnings = validateBoard(board, turn, pieceLimits);
    const confidence = scoreFromLogLikelihood(beam.logLikelihood);
    const score = penalizedScore(beam.logLikelihood, warnings);
    candidates.push({ recognized: board, confidence, score, warnings });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_POSITION_CANDIDATES);
};

const buildUnconstrainedCandidates = (
  recognized: RecognizedCell[][],
  turn: "black" | "white",
): Array<{
  recognized: RecognizedCell[][];
  confidence: number;
  score: number;
  warnings: VisionWarning[];
}> => {
  const cellOptions = precomputeScoredCells(recognized);
  let beams: UnconstrainedBeamState[] = [{ logLikelihood: 0, tail: null }];

  for (const options of cellOptions) {
    const expanded: UnconstrainedBeamState[] = [];
    for (const beam of beams) {
      for (const option of options) {
        expanded.push({
          logLikelihood: beam.logLikelihood + option.logProb,
          tail: { previous: beam.tail, cell: option },
        });
      }
    }
    beams = expanded.sort((a, b) => b.logLikelihood - a.logLikelihood).slice(0, BEAM_WIDTH);
  }

  const candidates: Array<{
    recognized: RecognizedCell[][];
    confidence: number;
    score: number;
    warnings: VisionWarning[];
  }> = [];
  const seen = new Set<string>();
  for (const beam of beams) {
    const board = toBoardFromScored(cellsFromBeam(beam.tail));
    const boardSfen = buildBoardSfen(board);
    if (seen.has(boardSfen)) continue;
    seen.add(boardSfen);
    const warnings = validateBoard(board, turn);
    const confidence = scoreFromLogLikelihood(beam.logLikelihood);
    const score = penalizedScore(beam.logLikelihood, warnings);
    candidates.push({ recognized: board, confidence, score, warnings });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_POSITION_CANDIDATES);
};

const precomputeScoredCells = (recognized: RecognizedCell[][]): ScoredCell[][] => {
  return recognized.flatMap((row) =>
    row.map((cell) => {
      const options = candidateOptions(cell);
      return options.map((opt) => ({
        piece: opt.piece,
        confidence: opt.confidence,
        logProb: Math.log(Math.max(MIN_PROBABILITY, Math.min(1.0, opt.confidence))),
        base: opt.piece !== null ? basePiece(opt.piece) : null,
        baseIndex: opt.piece !== null ? (PIECE_BASE_INDEX[basePiece(opt.piece)] ?? -1) : -1,
        candidates: opt.candidates,
      }));
    }),
  );
};

const candidateOptions = (cell: RecognizedCell): RecognizedCell[] => {
  const bestByPiece = new Map<string | null, number>();
  bestByPiece.set(cell.piece, cell.confidence);
  for (const c of cell.candidates) {
    const existing = bestByPiece.get(c.piece) ?? -Infinity;
    bestByPiece.set(c.piece, Math.max(existing, c.confidence));
  }
  return [...bestByPiece.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([piece, confidence]) => ({ piece, confidence, candidates: cell.candidates }));
};

const appendConstrainedOption = (
  beam: BeamState,
  option: ScoredCell,
  limits: Record<string, number>,
): BeamState | null => {
  const baseCounts = new Uint8Array(beam.baseCounts);
  if (option.baseIndex >= 0) {
    baseCounts[option.baseIndex]++;
    if (baseCounts[option.baseIndex] > (limits[option.base ?? ""] ?? 0)) return null;
  }
  return {
    logLikelihood: beam.logLikelihood + option.logProb,
    tail: { previous: beam.tail, cell: option },
    baseCounts,
  };
};

const cellsFromBeam = (tail: BeamNode | null): ScoredCell[] => {
  const cells: ScoredCell[] = [];
  for (let node = tail; node !== null; node = node.previous) {
    cells.push(node.cell);
  }
  cells.reverse();
  return cells;
};

const toBoardFromScored = (cells: ScoredCell[]): RecognizedCell[][] => {
  const board: RecognizedCell[][] = [];
  for (let row = 0; row < 9; row++) {
    const rowCells: RecognizedCell[] = [];
    for (let col = 0; col < 9; col++) {
      const cell = cells[row * 9 + col];
      rowCells.push({
        piece: cell.piece,
        confidence: cell.confidence,
        candidates: cell.candidates,
      });
    }
    board.push(rowCells);
  }
  return board;
};

const buildBoardSfen = (recognized: (RecognizedCell | ScoredCell)[][]): string => {
  return recognized
    .map((row) => {
      let empty = 0;
      const parts: string[] = [];
      for (const cell of row) {
        if (cell.piece === null) {
          empty++;
          continue;
        }
        if (empty > 0) {
          parts.push(String(empty));
          empty = 0;
        }
        parts.push(cell.piece);
      }
      if (empty > 0) parts.push(String(empty));
      return parts.join("");
    })
    .join("/");
};

export const buildHandSfen = (handCounts: Record<string, number>): string => {
  const order = ["R", "B", "G", "S", "N", "L", "P"];
  const parts: string[] = [];

  for (const piece of order) {
    const count = handCounts[piece] ?? 0;
    if (count > 0) parts.push(count > 1 ? `${count}${piece}` : piece);
  }
  for (const piece of order) {
    const lower = piece.toLowerCase();
    const count = handCounts[lower] ?? 0;
    if (count > 0) parts.push(count > 1 ? `${count}${lower}` : lower);
  }

  return parts.length > 0 ? parts.join("") : "-";
};

const basePiece = (piece: string): string => {
  return PROMOTED_TO_BASE[piece] ?? piece.toUpperCase();
};

const scoreFromLogLikelihood = (logLikelihood: number): number => {
  return Math.exp(logLikelihood / 81);
};

const penalizedScore = (logLikelihood: number, warnings: VisionWarning[]): number => {
  return Math.exp(logLikelihood / 81 - warningPenalty(warnings));
};

const warningPenalty = (warnings: VisionWarning[]): number => {
  return warnings.reduce((sum, w) => sum + (VIOLATION_PENALTIES[w.code] ?? 1.0), 0);
};

const validateBoard = (
  recognized: RecognizedCell[][],
  turn: "black" | "white",
  pieceLimits?: Record<string, number>,
): VisionWarning[] => {
  const limits = pieceLimits ?? PIECE_LIMITS;
  const warnings: VisionWarning[] = [];
  const pieces = recognized
    .flat()
    .map((c) => c.piece)
    .filter((p): p is string => p !== null);

  const baseCounts: Record<string, number> = {};
  let blackKing = 0;
  let whiteKing = 0;

  for (const piece of pieces) {
    const base = basePiece(piece);
    baseCounts[base] = (baseCounts[base] ?? 0) + 1;
    if (piece === "K") blackKing++;
    else if (piece === "k") whiteKing++;
  }

  if (blackKing > 1 || whiteKing > 1) {
    warnings.push({ code: "KING_COUNT_INVALID", message: "Too many kings on the board." });
  }

  for (const [piece, limit] of Object.entries(limits)) {
    if ((baseCounts[piece] ?? 0) > limit) {
      warnings.push({
        code: "PIECE_COUNT_INVALID",
        message: `Too many ${piece} pieces on the board.`,
      });
    }
  }

  warnings.push(...validatePawns(recognized));
  warnings.push(...validateImmobilePieces(recognized));
  return warnings;
};

const validateTotalPieces = (
  recognized: RecognizedCell[][],
  handCounts: Record<string, number> | null,
): VisionWarning[] => {
  const boardPieces = recognized.flat().filter((c) => c.piece !== null).length;
  let total = boardPieces;
  if (handCounts) {
    total += Object.values(handCounts).reduce((a, b) => a + b, 0);
  }
  if (total !== 40) {
    return [
      {
        code: "TOTAL_PIECE_COUNT_INVALID",
        message: `Expected 40 pieces total (board + hands), but found ${total}.`,
      },
    ];
  }
  return [];
};

const validatePawns = (recognized: RecognizedCell[][]): VisionWarning[] => {
  const warnings: VisionWarning[] = [];
  const blackFiles: Record<number, number> = {};
  const whiteFiles: Record<number, number> = {};

  for (let rowIdx = 0; rowIdx < recognized.length; rowIdx++) {
    for (let colIdx = 0; colIdx < recognized[rowIdx].length; colIdx++) {
      const piece = recognized[rowIdx][colIdx].piece;
      if (piece === "P") blackFiles[colIdx] = (blackFiles[colIdx] ?? 0) + 1;
      else if (piece === "p") whiteFiles[colIdx] = (whiteFiles[colIdx] ?? 0) + 1;
    }
  }

  for (const [col, count] of Object.entries(blackFiles)) {
    if (count > 1) {
      warnings.push({
        code: "ILLEGAL_PAWN",
        message: "Multiple black pawns were detected on the same file.",
        square: String(9 - Number(col)),
      });
    }
  }
  for (const [col, count] of Object.entries(whiteFiles)) {
    if (count > 1) {
      warnings.push({
        code: "ILLEGAL_PAWN",
        message: "Multiple white pawns were detected on the same file.",
        square: String(9 - Number(col)),
      });
    }
  }

  return warnings;
};

const validateImmobilePieces = (recognized: RecognizedCell[][]): VisionWarning[] => {
  const warnings: VisionWarning[] = [];
  for (let rowIdx = 0; rowIdx < recognized.length; rowIdx++) {
    for (let colIdx = 0; colIdx < recognized[rowIdx].length; colIdx++) {
      const piece = recognized[rowIdx][colIdx].piece;
      if (
        ((piece === "P" || piece === "L") && rowIdx === 0) ||
        (piece === "N" && rowIdx <= 1) ||
        ((piece === "p" || piece === "l") && rowIdx === 8) ||
        (piece === "n" && rowIdx >= 7)
      ) {
        warnings.push({
          code: "IMMOBILE_PIECE",
          message: `Immobile ${piece} was detected.`,
          square: squareName(rowIdx, colIdx),
        });
      }
    }
  }
  return warnings;
};

const squareName = (row: number, col: number): string => {
  return `${9 - col}${RANKS[row]}`;
};

const adjustedLimits = (handCounts: Record<string, number>): Record<string, number> => {
  const adjustment: Record<string, number> = {};
  for (const [piece, count] of Object.entries(handCounts)) {
    const base = basePiece(piece);
    adjustment[base] = (adjustment[base] ?? 0) + count;
  }
  const limits: Record<string, number> = {};
  for (const [piece, limit] of Object.entries(PIECE_LIMITS)) {
    limits[piece] = Math.max(0, limit - (adjustment[piece] ?? 0));
  }
  return limits;
};
