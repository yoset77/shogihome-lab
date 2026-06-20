import { describe, expect, it } from "vitest";
import { Color, Piece, PieceType, Position, Square } from "tsshogi";
import {
  computePieceBoxCounts,
  correctPieceCount,
  detectPieceCountViolations,
  fillUnusedPiecesToWhiteHand,
  pieceTypeToPieceBoxKey,
} from "@/common/game/pieceBox";

describe("pieceBox", () => {
  describe("pieceTypeToPieceBoxKey", () => {
    it("maps promoted pieces to their base piece keys", () => {
      expect(pieceTypeToPieceBoxKey(PieceType.PROM_PAWN)).toBe("pawn");
      expect(pieceTypeToPieceBoxKey(PieceType.PROM_LANCE)).toBe("lance");
      expect(pieceTypeToPieceBoxKey(PieceType.PROM_KNIGHT)).toBe("knight");
      expect(pieceTypeToPieceBoxKey(PieceType.PROM_SILVER)).toBe("silver");
      expect(pieceTypeToPieceBoxKey(PieceType.HORSE)).toBe("bishop");
      expect(pieceTypeToPieceBoxKey(PieceType.DRAGON)).toBe("rook");
    });
  });

  describe("computePieceBoxCounts", () => {
    it("returns zero for standard position", () => {
      const position = Position.newBySFEN(
        "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
      )!;
      const counts = computePieceBoxCounts(position);
      expect(counts.pawn).toBe(0);
      expect(counts.lance).toBe(0);
      expect(counts.knight).toBe(0);
      expect(counts.silver).toBe(0);
      expect(counts.gold).toBe(0);
      expect(counts.bishop).toBe(0);
      expect(counts.rook).toBe(0);
      expect(counts.king).toBe(0);
    });

    it("counts promoted pieces as base pieces", () => {
      const position = Position.newBySFEN(
        "l4+N2l/6k2/2G2p3/p1sr2pgp/2p2N1p1/PP1S1PP1P/1G1PP4/3K1+b3/L6RL b S2N2Pbgs3p 95",
      )!;
      const counts = computePieceBoxCounts(position);
      expect(counts.pawn).toBe(0);
      expect(counts.lance).toBe(0);
      expect(counts.knight).toBe(0);
      expect(counts.silver).toBe(0);
      expect(counts.gold).toBe(0);
      expect(counts.bishop).toBe(0);
      expect(counts.rook).toBe(0);
      expect(counts.king).toBe(0);
    });
  });

  describe("fillUnusedPiecesToWhiteHand", () => {
    it("moves all unused non-king pieces to white hand", () => {
      const position = Position.newBySFEN("9/9/9/9/9/9/9/9/9 b - 1")!;
      position.board.set(new Square(5, 9), new Piece(Color.BLACK, PieceType.KING));
      position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.KING));
      position.board.set(new Square(7, 7), new Piece(Color.BLACK, PieceType.PAWN));
      position.hand(Color.BLACK).add(PieceType.ROOK, 1);

      const filled = fillUnusedPiecesToWhiteHand(position);
      const counts = computePieceBoxCounts(filled);

      expect(counts.pawn).toBe(0);
      expect(counts.lance).toBe(0);
      expect(counts.knight).toBe(0);
      expect(counts.silver).toBe(0);
      expect(counts.gold).toBe(0);
      expect(counts.bishop).toBe(0);
      expect(counts.rook).toBe(0);
      expect(counts.king).toBe(0);
      expect(filled.hand(Color.WHITE).count(PieceType.PAWN)).toBe(17);
      expect(filled.hand(Color.WHITE).count(PieceType.ROOK)).toBe(1);
      expect(filled.hand(Color.BLACK).count(PieceType.ROOK)).toBe(1);
    });

    it("does not add unused kings to hand", () => {
      const position = Position.newBySFEN("9/9/9/9/9/9/9/9/9 b - 1")!;

      const filled = fillUnusedPiecesToWhiteHand(position);
      const counts = computePieceBoxCounts(filled);

      expect(counts.king).toBe(2);
    });
  });

  describe("detectPieceCountViolations", () => {
    it("returns empty for standard position", () => {
      const position = Position.newBySFEN(
        "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
      )!;
      const violations = detectPieceCountViolations(position);
      expect(violations).toEqual([]);
    });

    it("detects excess pawns", () => {
      const position = new Position();
      position.board.set(new Square(9, 4), new Piece(Color.BLACK, PieceType.PAWN));
      position.board.set(new Square(8, 4), new Piece(Color.BLACK, PieceType.PAWN));
      const violations = detectPieceCountViolations(position);
      expect(violations).toEqual([{ pieceType: PieceType.PAWN, excess: 2 }]);
    });

    it("detects excess kings", () => {
      const position = new Position();
      position.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.KING));
      const violations = detectPieceCountViolations(position);
      expect(violations).toEqual([{ pieceType: PieceType.KING, excess: 1 }]);
    });
  });

  describe("correctPieceCount", () => {
    it("removes excess pawns from board", () => {
      const position = new Position();
      position.board.set(new Square(9, 4), new Piece(Color.BLACK, PieceType.PAWN));
      position.board.set(new Square(8, 4), new Piece(Color.BLACK, PieceType.PAWN));
      const corrected = correctPieceCount(position);
      const violations = detectPieceCountViolations(corrected);
      expect(violations).toEqual([]);
      let pawnCount = 0;
      for (const square of Square.all) {
        const piece = corrected.board.at(square);
        if (piece && piece.type === PieceType.PAWN) {
          pawnCount++;
        }
      }
      expect(pawnCount).toBe(18);
    });

    it("removes excess pawns from hand first", () => {
      const position = Position.newBySFEN("9/9/9/9/9/9/9/9/9 b 19P 1")!;
      const corrected = correctPieceCount(position);
      const violations = detectPieceCountViolations(corrected);
      expect(violations).toEqual([]);
      expect(corrected.hand(Color.BLACK).count(PieceType.PAWN)).toBe(18);
    });

    it("removes excess kings", () => {
      const position = new Position();
      position.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.KING));
      const corrected = correctPieceCount(position);
      const violations = detectPieceCountViolations(corrected);
      expect(violations).toEqual([]);
      let kingCount = 0;
      for (const square of Square.all) {
        const piece = corrected.board.at(square);
        if (piece && piece.type === PieceType.KING) {
          kingCount++;
        }
      }
      expect(kingCount).toBe(2);
    });
  });
});
