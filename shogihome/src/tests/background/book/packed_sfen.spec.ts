import {
  packedSfenToSfen,
  positionToPackedSfen,
  sfenToPackedSfen,
} from "@/server/book/packed_sfen";
import { Position } from "tsshogi";

describe("background/book/packed_sfen", () => {
  const sfens = [
    "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL w - 4",
    "lnsgkgsnl/1r7/pppp1p2p/4p1p2/7R1/2P6/PP1PPPP1P/1S1K5/LN1G1GSNL b BPbp 13",
  ];

  for (const sfen of sfens) {
    it(`roundtrips ${sfen}`, () => {
      expect(packedSfenToSfen(sfenToPackedSfen(sfen))).toBe(sfen.replace(/\s+\d+$/, " 1"));
    });
  }

  it("matches Position-based packing", () => {
    for (const sfen of sfens) {
      const pos = Position.newBySFEN(sfen);
      if (!pos) {
        throw new Error(`Invalid test SFEN: ${sfen}`);
      }
      expect(Array.from(positionToPackedSfen(pos))).toEqual(Array.from(sfenToPackedSfen(sfen)));
    }
  });

  it("rejects malformed SFEN", () => {
    expect(() => sfenToPackedSfen("invalid")).toThrow("Invalid SFEN");
  });
});
