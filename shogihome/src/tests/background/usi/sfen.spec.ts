import { describe, expect, it } from "vitest";
import { getNormalizedSfenAndHash } from "@/background/usi/sfen.js";

describe("background/usi/sfen", () => {
  it("should parse 'position startpos' and return normalized sfen", () => {
    const result = getNormalizedSfenAndHash("position startpos");
    expect(result).not.toBeNull();
    expect(result!.sfen).toBe("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -");
    expect(typeof result!.hash).toBe("bigint");
  });

  it("should parse 'position startpos moves ...' and return normalized sfen", () => {
    const result = getNormalizedSfenAndHash("position startpos moves 7g7f 3c3d");
    expect(result).not.toBeNull();
    // 7g7f 3c3d applies correctly.
    // expected SFEN: "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b -"
    expect(result!.sfen).toBe("lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b -");
  });

  it("should handle 'startpos moves ...' without 'position ' prefix", () => {
    const result = getNormalizedSfenAndHash("startpos moves 7g7f");
    expect(result).not.toBeNull();
    expect(result!.sfen).toBe("lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w -");
  });

  it("should handle raw SFEN strings", () => {
    const rawSfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
    const result = getNormalizedSfenAndHash(rawSfen);
    expect(result).not.toBeNull();
    expect(result!.sfen).toBe("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -");
  });

  it("should return null for invalid commands", () => {
    const result = getNormalizedSfenAndHash("position invalid");
    expect(result).toBeNull();
  });
});
