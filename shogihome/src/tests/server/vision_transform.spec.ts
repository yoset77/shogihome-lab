import { describe, expect, it } from "vitest";
import type { VisionScanResponse } from "@/common/vision/types";
import { transformVisionResponse } from "@/server/vision/transform";

const RESPONSE: VisionScanResponse = {
  ok: true,
  sfen: "l8/2+P3s1R/b3g1kp1/p2p2psp/2nPSp3/PPP2LP1P/K3P4/2GSG4/LN4+b1L w G2Pr2n2p 114",
  confidence: 0.9,
  candidates: [
    {
      sfen: "6+Pn1/6gk1/6gp1/9/9/6b1P/9/9/9 b 2R2Gb4s3n4l15p 1",
      score: 0.8,
      violations: [{ code: "IMMOBILE_PIECE", message: "x", square: "9a" }],
    },
  ],
  warnings: [
    { code: "ILLEGAL_PAWN", message: "file", square: "9" },
    { code: "IMMOBILE_PIECE", message: "square", square: "8b" },
  ],
};

describe("Vision response transform", () => {
  it("keeps black viewpoint responses unchanged except internal board fields", () => {
    const response = { ...RESPONSE, board: [[{ internal: true }]] };

    const transformed = transformVisionResponse(response, "white", "black");

    expect(transformed).toEqual(RESPONSE);
    expect("board" in transformed).toBe(false);
  });

  it("flips SFENs and warning squares for white viewpoint while preserving side to move", () => {
    const transformed = transformVisionResponse(RESPONSE, "white", "white");

    expect(transformed.sfen).toBe(
      "l1+B4nl/4gsg2/4p3k/p1pl2ppp/3PspN2/PSP2P2P/1PK1G3B/r1S3+p2/8L w R2N2Pg2p 114",
    );
    expect(transformed.candidates[0].sfen).toBe(
      "9/9/9/p1B6/9/9/1PG6/1KG6/1N+p6 w B4S3N4L15P2r2g 1",
    );
    expect(transformed.warnings.map((warning) => warning.square)).toEqual(["1", "2h"]);
    expect(transformed.candidates[0].violations[0].square).toBe("1i");
  });
});
