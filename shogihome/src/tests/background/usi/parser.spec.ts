import { describe, expect, it } from "vitest";
import { parseInfoCommand } from "@/background/usi/parser.js";
import { SCORE_MATE_INFINITE } from "@/common/game/usi.js";

describe("background/usi/parser", () => {
  it("should parse info command with depth, time, nodes, score cp, and pv", () => {
    const result = parseInfoCommand(
      "depth 10 time 1234 nodes 56789 score cp 300 pv 7g7f 3c3d 2g2f",
    );
    expect(result.depth).toBe(10);
    expect(result.timeMs).toBe(1234);
    expect(result.nodes).toBe(56789);
    expect(result.scoreCP).toBe(300);
    expect(result.scoreMate).toBeUndefined();
    expect(result.pv).toEqual(["7g7f", "3c3d", "2g2f"]);
    expect(result.multipv).toBeUndefined();
  });

  it("should parse info command with multipv and score mate", () => {
    const result = parseInfoCommand("multipv 2 depth 15 score mate 5 pv 8h2b+ 3a2b");
    expect(result.multipv).toBe(2);
    expect(result.depth).toBe(15);
    expect(result.scoreCP).toBeUndefined();
    expect(result.scoreMate).toBe(5);
    expect(result.pv).toEqual(["8h2b+", "3a2b"]);
  });

  it("should parse info command with upperbound/lowerbound", () => {
    const result = parseInfoCommand("depth 8 score cp 150 lowerbound");
    expect(result.depth).toBe(8);
    expect(result.scoreCP).toBe(150);
    expect(result.lowerbound).toBe(true);
    expect(result.upperbound).toBeUndefined();

    const result2 = parseInfoCommand("depth 8 score cp 150 upperbound");
    expect(result2.depth).toBe(8);
    expect(result2.scoreCP).toBe(150);
    expect(result2.upperbound).toBe(true);
    expect(result2.lowerbound).toBeUndefined();
  });

  it("should handle mate infinite", () => {
    expect(parseInfoCommand("score mate +").scoreMate).toBe(SCORE_MATE_INFINITE);
    expect(parseInfoCommand("score mate +0").scoreMate).toBe(SCORE_MATE_INFINITE);
    expect(parseInfoCommand("score mate 0").scoreMate).toBe(SCORE_MATE_INFINITE);
    expect(parseInfoCommand("score mate -").scoreMate).toBe(-SCORE_MATE_INFINITE);
    expect(parseInfoCommand("score mate -0").scoreMate).toBe(-SCORE_MATE_INFINITE);
  });
});
