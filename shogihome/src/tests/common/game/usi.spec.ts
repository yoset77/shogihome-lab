import { parseInfoCommand, SCORE_MATE_INFINITE } from "@/common/game/usi";

describe("common/game/usi", () => {
  it("parses depth, time, nodes, centipawn score, and PV", () => {
    const result = parseInfoCommand(
      "depth 10 time 1234 nodes 56789 score cp 300 pv 7g7f 3c3d 2g2f",
    );

    expect(result).toStrictEqual({
      depth: 10,
      timeMs: 1234,
      nodes: 56789,
      scoreCP: 300,
      pv: ["7g7f", "3c3d", "2g2f"],
    });
  });

  it("parses multipv and mate score", () => {
    expect(parseInfoCommand("multipv 2 depth 15 score mate 5 pv 8h2b+ 3a2b")).toStrictEqual({
      multipv: 2,
      depth: 15,
      scoreMate: 5,
      pv: ["8h2b+", "3a2b"],
    });
  });

  it("parses score bounds", () => {
    expect(parseInfoCommand("depth 8 score cp 150 lowerbound")).toStrictEqual({
      depth: 8,
      scoreCP: 150,
      lowerbound: true,
    });
    expect(parseInfoCommand("depth 8 score cp 150 upperbound")).toStrictEqual({
      depth: 8,
      scoreCP: 150,
      upperbound: true,
    });
  });

  it("normalizes indefinite mate scores", () => {
    expect(parseInfoCommand("score mate +").scoreMate).toBe(SCORE_MATE_INFINITE);
    expect(parseInfoCommand("score mate +0").scoreMate).toBe(SCORE_MATE_INFINITE);
    expect(parseInfoCommand("score mate 0").scoreMate).toBe(SCORE_MATE_INFINITE);
    expect(parseInfoCommand("score mate -").scoreMate).toBe(-SCORE_MATE_INFINITE);
    expect(parseInfoCommand("score mate -0").scoreMate).toBe(-SCORE_MATE_INFINITE);
  });
});
