import { describe, expect, it } from "vitest";
import { parseVisionScanResponse } from "@/server/vision/schema";

const STARTPOS_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

describe("Vision response schema", () => {
  it("rejects candidates with missing score", () => {
    expect(() =>
      parseVisionScanResponse({
        ok: true,
        sfen: STARTPOS_SFEN,
        confidence: 0.9,
        candidates: [{ sfen: STARTPOS_SFEN, violations: [] }],
        warnings: [],
      }),
    ).toThrow("invalid response shape");
  });

  it("accepts valid candidates and warnings", () => {
    expect(
      parseVisionScanResponse({
        ok: true,
        sfen: STARTPOS_SFEN,
        confidence: 0.9,
        candidates: [{ sfen: STARTPOS_SFEN, score: 0.9, violations: [] }],
        warnings: [{ code: "LOW_CONFIDENCE", message: "low", square: "7g" }],
      }).sfen,
    ).toBe(STARTPOS_SFEN);
  });
});
