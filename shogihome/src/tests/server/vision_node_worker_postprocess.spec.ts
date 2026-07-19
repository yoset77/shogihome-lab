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

  it("does not remove strong board pieces because of a hand false positive", () => {
    const recognized = Array.from({ length: 9 }, () => Array.from({ length: 9 }, emptyCell));
    recognized[4][4] = {
      piece: "R",
      confidence: 0.99,
      candidates: [
        { piece: "R", confidence: 0.99 },
        { piece: null, confidence: 0.01 },
      ],
    };
    recognized[4][5] = {
      piece: "R",
      confidence: 0.98,
      candidates: [
        { piece: "R", confidence: 0.98 },
        { piece: null, confidence: 0.02 },
      ],
    };

    const response = assemblePosition(recognized, "black", [], { R: 1 });

    expect(response.sfen).toBe("9/9/9/9/4RR3/9/9/9/9 b R 1");
    expect(response.warnings.some((warning) => warning.code === "PIECE_COUNT_INVALID")).toBe(true);
    expect(response.candidates[0].sfen).toBe(response.sfen);
    expect(
      response.candidates[0].violations.some((warning) => warning.code === "PIECE_COUNT_INVALID"),
    ).toBe(true);
  });

  it("warns when hand pieces alone exceed the physical inventory", () => {
    const recognized = Array.from({ length: 9 }, () => Array.from({ length: 9 }, emptyCell));

    const response = assemblePosition(recognized, "black", [], { R: 3 });

    expect(response.sfen).toBe("9/9/9/9/9/9/9/9/9 b 3R 1");
    expect(response.warnings.some((warning) => warning.code === "PIECE_COUNT_INVALID")).toBe(true);
  });

  it("keeps the board hard limit when cells do not provide empty candidates", () => {
    const recognized = Array.from({ length: 9 }, () => Array.from({ length: 9 }, emptyCell));
    for (let col = 0; col < 9; col++) {
      recognized[2][col] = {
        piece: "P",
        confidence: 0.99,
        candidates: [{ piece: "P", confidence: 0.99 }],
      };
      recognized[6][col] = {
        piece: "p",
        confidence: 0.99,
        candidates: [{ piece: "p", confidence: 0.99 }],
      };
    }
    recognized[4][0] = {
      piece: "P",
      confidence: 0.99,
      candidates: [{ piece: "P", confidence: 0.99 }],
    };

    const response = assemblePosition(recognized, "black", [], null);
    const boardSfen = response.sfen.split(" ")[0];

    expect(boardSfen.match(/[Pp]/g)).toHaveLength(18);
    expect(response.warnings.some((warning) => warning.code === "PIECE_COUNT_INVALID")).toBe(false);
  });
});
