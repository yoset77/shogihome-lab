import { describe, expect, it } from "vitest";
import { cellFromPredictions } from "@/server/vision/node-worker/recognizer";

describe("Node vision worker recognizer", () => {
  it("normalizes valid figure and direction combinations", () => {
    const figures = new Float32Array(15);
    figures[0] = 0.6;
    figures[8] = 0.4;
    const directions = new Float32Array([0.5, 0.25, 0.25]);

    const cell = cellFromPredictions(figures, directions);

    expect(cell.piece).toBe("P");
    expect(cell.confidence).toBeCloseTo(0.3 / 0.55);
    expect(cell.candidates).toEqual([
      { piece: "P", confidence: expect.closeTo(0.3 / 0.55) },
      { piece: "p", confidence: expect.closeTo(0.15 / 0.55) },
      { piece: null, confidence: expect.closeTo(0.1 / 0.55) },
    ]);
    expect(cell.candidates.reduce((sum, candidate) => sum + candidate.confidence, 0)).toBeCloseTo(
      1,
    );
  });
});
