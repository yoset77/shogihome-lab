import { getNormalizedSfenAndHash } from "@/server/usi/sfen";

describe("server/usi/sfen", () => {
  it("normalizes position startpos", () => {
    const result = getNormalizedSfenAndHash("position startpos");

    expect(result?.sfen).toBe("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -");
    expect(typeof result?.hash).toBe("bigint");
  });

  it("applies moves before normalizing", () => {
    const result = getNormalizedSfenAndHash("position startpos moves 7g7f 3c3d");

    expect(result?.sfen).toBe("lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b -");
  });

  it("accepts startpos without the position prefix", () => {
    const result = getNormalizedSfenAndHash("startpos moves 7g7f");

    expect(result?.sfen).toBe("lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w -");
  });

  it("accepts raw SFEN", () => {
    const result = getNormalizedSfenAndHash(
      "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    );

    expect(result?.sfen).toBe("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -");
  });

  it("rejects invalid commands", () => {
    expect(getNormalizedSfenAndHash("position invalid")).toBeNull();
  });
});
