import { Color } from "tsshogi";
import { parseInfoCommand, SCORE_MATE_INFINITE, toBlackSearchScore } from "@/common/game/usi";

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

  describe.each([
    { color: Color.BLACK, bound: "lowerbound", lowerBound: true, upperBound: undefined, sign: 1 },
    { color: Color.BLACK, bound: "upperbound", lowerBound: undefined, upperBound: true, sign: 1 },
    { color: Color.WHITE, bound: "lowerbound", lowerBound: undefined, upperBound: true, sign: -1 },
    { color: Color.WHITE, bound: "upperbound", lowerBound: true, upperBound: undefined, sign: -1 },
  ])(
    "black-perspective scores for $color $bound",
    ({ color, bound, lowerBound, upperBound, sign }) => {
      it.each(["cp", "mate"])("converts %s scores together with their bounds", (kind) => {
        for (const score of [-100, 0, 100]) {
          const mate = score === 0 ? SCORE_MATE_INFINITE : score;
          expect(
            toBlackSearchScore(parseInfoCommand(`score ${kind} ${score} ${bound}`), color),
          ).toStrictEqual({
            score: kind === "cp" ? (score === 0 ? 0 : score * sign) : undefined,
            mate: kind === "mate" ? mate * sign : undefined,
            lowerBound,
            upperBound,
          });
        }
      });
    },
  );

  it.each([Color.BLACK, Color.WHITE])("normalizes signed centipawn zeros for %s", (color) => {
    for (const scoreCP of [0, -0]) {
      expect(toBlackSearchScore({ scoreCP }, color).score).toBe(0);
    }
  });

  it.each([Color.BLACK, Color.WHITE])(
    "returns a score patch with explicit resets for %s",
    (color) => {
      expect(toBlackSearchScore({ scoreCP: 100 }, color)).toStrictEqual({
        score: color === Color.BLACK ? 100 : -100,
        mate: undefined,
        lowerBound: undefined,
        upperBound: undefined,
      });
      expect(toBlackSearchScore({ scoreMate: 3 }, color)).toStrictEqual({
        score: undefined,
        mate: color === Color.BLACK ? 3 : -3,
        lowerBound: undefined,
        upperBound: undefined,
      });
      expect(toBlackSearchScore({ depth: 10, nodes: 200 }, color)).toStrictEqual({});
    },
  );
});
