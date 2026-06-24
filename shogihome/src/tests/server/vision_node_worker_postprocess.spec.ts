import { describe, expect, it } from "vitest";
import { assemblePosition } from "@/server/vision/node-worker/postprocess";
import type { RecognizedCell } from "@/server/vision/node-worker/types";

const emptyCell = (): RecognizedCell => ({
  piece: null,
  confidence: 0.99,
  candidates: [{ piece: null, confidence: 0.99 }],
});

describe("Node vision worker postprocess", () => {
  it("assembles all 81 cells during beam search", () => {
    const recognized = Array.from({ length: 9 }, () => Array.from({ length: 9 }, emptyCell));
    recognized[8][0] = {
      piece: "L",
      confidence: 0.95,
      candidates: [
        { piece: "L", confidence: 0.95 },
        { piece: null, confidence: 0.05 },
      ],
    };

    const response = assemblePosition(recognized, "black", [], null);

    expect(response.sfen).toBe("9/9/9/9/9/9/9/9/L8 b - 1");
  });
});
