export type VisionTurn = "black" | "white";
export type VisionViewpoint = "black" | "white";
export type VisionPositionType = "game" | "mate";

export type VisionPiece =
  | "P"
  | "L"
  | "N"
  | "S"
  | "G"
  | "B"
  | "R"
  | "K"
  | "+P"
  | "+L"
  | "+N"
  | "+S"
  | "+B"
  | "+R"
  | "p"
  | "l"
  | "n"
  | "s"
  | "g"
  | "b"
  | "r"
  | "k"
  | "+p"
  | "+l"
  | "+n"
  | "+s"
  | "+b"
  | "+r";

export type VisionCellCandidate = {
  piece: VisionPiece | null;
  confidence: number;
};

export type VisionCell = {
  square: string;
  piece: VisionPiece | null;
  confidence: number;
  candidates: VisionCellCandidate[];
};

export type VisionWarningCode =
  | "LOW_CONFIDENCE"
  | "BOARD_NOT_FOUND"
  | "INVALID_SFEN"
  | "MISSING_HANDS"
  | "PIECE_COUNT_INVALID"
  | "TOTAL_PIECE_COUNT_INVALID"
  | "KING_COUNT_INVALID"
  | "ILLEGAL_PAWN"
  | "IMMOBILE_PIECE"
  | "WRAPPER_ERROR";

export type VisionWarning = {
  code: VisionWarningCode;
  message: string;
  square?: string;
};

export type VisionPositionCandidate = {
  sfen: string;
  score: number;
  violations: VisionWarning[];
};

export type VisionScanResponse = {
  ok: true;
  sfen: string;
  confidence: number;
  candidates: VisionPositionCandidate[];
  warnings: VisionWarning[];
  preview?: {
    boardImageUrl?: string;
    overlayImageUrl?: string;
  };
};
