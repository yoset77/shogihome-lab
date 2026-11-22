import {
  packedSfenToSfen,
  positionToPackedSfen,
  sfenToPackedSfen,
} from "@/server/book/packed_sfen";
import { Position } from "tsshogi";

describe("server/book/packed_sfen", () => {
  const sparseSfen = "4k4/9/9/2+R+p+B4/9/2+l+N+s4/9/9/4K4 w 2Pbp 17";
  // Reference words from the existing codec, including pieces left in the piece box.
  const sparsePacked = Uint32Array.of(
    0x00002459,
    0xcbe00000,
    0xfc06da0d,
    0x00000199,
    0x4924a7c0,
    0x29492492,
    0x5adad6a5,
    0x7fbdef6b,
  );

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

  it("matches YaneuraOu packed SFEN bytes", () => {
    const testCases = [
      {
        sfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
        expected: "58a451220ceb67227e9653221caf447824c22b119e53221ceb6f223e9651220c",
      },
      {
        sfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPP1/1B5R1/LNSGKGSNL b P 1",
        expected: "58a4518261fd4cc4cf724a84e395088f447825c2734a8463fd4dc4c7324a8401",
      },
      {
        sfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1",
        expected: "59a451220ceb67227e9653221caf447824c22b119e53221ceb6f223e9651220c",
      },
      {
        sfen: "4k4/9/9/9/9/9/9/9/4K4 b 2R2B4G4S4N4L18P 1",
        expected: "582400000000000000000000000000000000104208a59432c618e79cf3787c3e",
      },
    ];
    for (const { sfen, expected } of testCases) {
      const packed = sfenToPackedSfen(sfen);
      expect(Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength).toString("hex")).toBe(
        expected,
      );
    }
  });

  it("rejects malformed SFEN", () => {
    expect(() => sfenToPackedSfen("invalid")).toThrow("Invalid SFEN");
  });

  it("preserves the packed representation of promoted pieces, hands, and the piece box", () => {
    const position = Position.newBySFEN(sparseSfen);
    if (!position) {
      throw new Error("Invalid test SFEN");
    }
    expect(sfenToPackedSfen(sparseSfen)).toEqual(sparsePacked);
    expect(positionToPackedSfen(position)).toEqual(sparsePacked);
    expect(packedSfenToSfen(sparsePacked, 17)).toBe(sparseSfen);
  });

  it("rejects writing past 256 bits", () => {
    const sfen = "4k4/9/9/9/9/9/9/9/9 b - 1";
    const position = Position.newBySFEN(sfen);
    if (!position) {
      throw new Error("Invalid test SFEN");
    }
    expect(() => sfenToPackedSfen(sfen)).toThrow("Packed SFEN overflow");
    expect(() => positionToPackedSfen(position)).toThrow("Packed SFEN overflow");
  });

  it("rejects a hand piece that extends past 256 bits", () => {
    const packed = sparsePacked.slice();
    packed[7] = 0xffffffff;
    expect(() => packedSfenToSfen(packed)).toThrow("Packed SFEN underflow");
  });

  it("rejects short input and invalid king squares", () => {
    expect(() => packedSfenToSfen(new Uint32Array(7))).toThrow("Packed SFEN requires 8 words");
    const packed = new Uint32Array(8);
    expect(() => packedSfenToSfen(packed)).toThrow("duplicated king square");
    packed[0] = 82 << 1;
    expect(() => packedSfenToSfen(packed)).toThrow("king square out of range");
  });
});
