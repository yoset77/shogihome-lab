import { Color, PieceType, pieceTypes } from "tsshogi";

export const pieceAssetTypes: (PieceType | "king2")[] = [...pieceTypes, "king2"];

export function getPieceImageAssetName(color: Color, piece: PieceType | "king2") {
  const snake = piece.replace(/([A-Z])/g, "_$1").toLowerCase();
  return `${color}_${snake}`;
}
