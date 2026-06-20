import { Color, PieceType, Position, Square } from "tsshogi";

export type PieceBoxCounts = {
  pawn: number;
  lance: number;
  knight: number;
  silver: number;
  gold: number;
  bishop: number;
  rook: number;
  king: number;
};

const PIECE_LIMITS: Record<PieceType, number> = {
  [PieceType.PAWN]: 18,
  [PieceType.LANCE]: 4,
  [PieceType.KNIGHT]: 4,
  [PieceType.SILVER]: 4,
  [PieceType.GOLD]: 4,
  [PieceType.BISHOP]: 2,
  [PieceType.ROOK]: 2,
  [PieceType.KING]: 2,
  [PieceType.PROM_PAWN]: 0,
  [PieceType.PROM_LANCE]: 0,
  [PieceType.PROM_KNIGHT]: 0,
  [PieceType.PROM_SILVER]: 0,
  [PieceType.HORSE]: 0,
  [PieceType.DRAGON]: 0,
};

export const PIECE_TYPE_TO_KEY: Record<PieceType, keyof PieceBoxCounts> = {
  [PieceType.PAWN]: "pawn",
  [PieceType.LANCE]: "lance",
  [PieceType.KNIGHT]: "knight",
  [PieceType.SILVER]: "silver",
  [PieceType.GOLD]: "gold",
  [PieceType.BISHOP]: "bishop",
  [PieceType.ROOK]: "rook",
  [PieceType.KING]: "king",
  [PieceType.PROM_PAWN]: "pawn",
  [PieceType.PROM_LANCE]: "lance",
  [PieceType.PROM_KNIGHT]: "knight",
  [PieceType.PROM_SILVER]: "silver",
  [PieceType.HORSE]: "bishop",
  [PieceType.DRAGON]: "rook",
};

export const pieceTypeToPieceBoxKey = (pieceType: PieceType): keyof PieceBoxCounts => {
  return PIECE_TYPE_TO_KEY[pieceType];
};

const BASE_PIECE_TYPES: PieceType[] = [
  PieceType.PAWN,
  PieceType.LANCE,
  PieceType.KNIGHT,
  PieceType.SILVER,
  PieceType.GOLD,
  PieceType.BISHOP,
  PieceType.ROOK,
  PieceType.KING,
];

export const computePieceBoxCounts = (position: Position): PieceBoxCounts => {
  const counts: PieceBoxCounts = {
    pawn: 0,
    lance: 0,
    knight: 0,
    silver: 0,
    gold: 0,
    bishop: 0,
    rook: 0,
    king: 0,
  };

  const boardCounts: Record<keyof PieceBoxCounts, number> = {
    pawn: 0,
    lance: 0,
    knight: 0,
    silver: 0,
    gold: 0,
    bishop: 0,
    rook: 0,
    king: 0,
  };

  for (const square of Square.all) {
    const piece = position.board.at(square);
    if (piece) {
      const key = pieceTypeToPieceBoxKey(piece.unpromoted().type);
      boardCounts[key]++;
    }
  }

  for (const color of [Color.BLACK, Color.WHITE]) {
    const hand = position.hand(color);
    for (const pieceType of BASE_PIECE_TYPES) {
      if (pieceType === PieceType.KING) continue;
      const key = pieceTypeToPieceBoxKey(pieceType);
      boardCounts[key] += hand.count(pieceType);
    }
  }

  for (const pieceType of BASE_PIECE_TYPES) {
    const limit = PIECE_LIMITS[pieceType];
    const k = pieceTypeToPieceBoxKey(pieceType);
    counts[k] = Math.max(0, limit - boardCounts[k]);
  }

  return counts;
};

export const detectPieceCountViolations = (
  position: Position,
): { pieceType: PieceType; excess: number }[] => {
  const violations: { pieceType: PieceType; excess: number }[] = [];

  const boardCounts: Record<PieceType, number> = {
    [PieceType.PAWN]: 0,
    [PieceType.LANCE]: 0,
    [PieceType.KNIGHT]: 0,
    [PieceType.SILVER]: 0,
    [PieceType.GOLD]: 0,
    [PieceType.BISHOP]: 0,
    [PieceType.ROOK]: 0,
    [PieceType.KING]: 0,
    [PieceType.PROM_PAWN]: 0,
    [PieceType.PROM_LANCE]: 0,
    [PieceType.PROM_KNIGHT]: 0,
    [PieceType.PROM_SILVER]: 0,
    [PieceType.HORSE]: 0,
    [PieceType.DRAGON]: 0,
  };

  for (const square of Square.all) {
    const piece = position.board.at(square);
    if (piece) {
      boardCounts[piece.unpromoted().type]++;
    }
  }

  for (const color of [Color.BLACK, Color.WHITE]) {
    const hand = position.hand(color);
    for (const pieceType of BASE_PIECE_TYPES) {
      if (pieceType === PieceType.KING) continue;
      boardCounts[pieceType] += hand.count(pieceType);
    }
  }

  for (const pieceType of BASE_PIECE_TYPES) {
    const limit = PIECE_LIMITS[pieceType];
    const count = boardCounts[pieceType];
    if (count > limit) {
      violations.push({ pieceType, excess: count - limit });
    }
  }

  return violations;
};

export const correctPieceCount = (position: Position): Position => {
  const cloned = position.clone();
  const violations = detectPieceCountViolations(cloned);

  if (violations.length === 0) {
    return cloned;
  }

  for (const { pieceType, excess } of violations) {
    for (let i = 0; i < excess; i++) {
      if (!removeOnePiece(cloned, pieceType)) {
        break;
      }
    }
  }

  return cloned;
};

export const fillUnusedPiecesToWhiteHand = (position: Position): Position => {
  const cloned = position.clone();
  const counts = computePieceBoxCounts(cloned);

  for (const pieceType of BASE_PIECE_TYPES) {
    if (pieceType === PieceType.KING) continue;
    const count = counts[pieceTypeToPieceBoxKey(pieceType)];
    if (count > 0) {
      cloned.hand(Color.WHITE).add(pieceType, count);
    }
  }

  return cloned;
};

const removeOnePiece = (position: Position, pieceType: PieceType): boolean => {
  if (pieceType !== PieceType.KING) {
    for (const color of [Color.BLACK, Color.WHITE]) {
      const hand = position.hand(color);
      if (hand.count(pieceType) > 0) {
        hand.reduce(pieceType, 1);
        return true;
      }
    }
  }

  for (const square of Square.all) {
    const piece = position.board.at(square);
    if (piece && piece.unpromoted().type === pieceType) {
      position.board.remove(square);
      return true;
    }
  }

  if (pieceType === PieceType.KING) {
    for (const color of [Color.BLACK, Color.WHITE]) {
      for (const square of Square.all) {
        const piece = position.board.at(square);
        if (piece && piece.type === PieceType.KING && piece.color === color) {
          position.board.remove(square);
          return true;
        }
      }
    }
  }

  return false;
};
