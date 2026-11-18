import { describe, it, expect, vi, afterEach } from "vitest";
import { Color } from "tsshogi";
import { filterBookMoves, selectBookMove } from "@/common/game/book";
import type { BookMove } from "@/common/book";
import { BookMoveSelectionRule } from "@/common/settings/usi";

describe("filterBookMoves", () => {
  const options = {
    moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_COUNT,
    scoreTemperature: 50,
    turn: Color.BLACK,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects the whole entry when the highest-scored move is shallow", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 100, score: 100, depth: 30, comment: "" },
      { usi: "2g2f", count: 1, score: 200, depth: 3, comment: "" },
    ];
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 10 })).toEqual([]);
  });

  it("excludes shallow and unknown depths even when the primary move passes", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 10, score: 100, depth: 30, comment: "" },
      { usi: "2g2f", count: 100, score: 90, depth: 3, comment: "" },
      { usi: "3g3f", count: 5, score: 90, comment: "" },
      { usi: "4g4f", count: 5, score: 90, depth: 10, comment: "" },
    ];
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 10 })).toEqual([
      moves[0],
      moves[3],
    ]);
  });

  it("treats a missing depth as zero below the limit", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 1, score: 200, comment: "" },
      { usi: "2g2f", count: 100, score: 100, depth: 30, comment: "" },
    ];
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 5 })).toEqual([]);
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 0 })).toEqual(moves);
  });

  it("breaks score ties by count, not by depth", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 10, score: 100, depth: 80, comment: "" },
      { usi: "2g2f", count: 20, score: 100, depth: 50, comment: "" },
    ];
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 60 })).toEqual([]);
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 50 })).toEqual(moves);
  });

  it("prefers a finite negative score over unknown scores without excluding deep unscored moves", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 100, depth: 3, comment: "" },
      { usi: "2g2f", count: 100, score: NaN, depth: 3, comment: "" },
      { usi: "3g3f", count: 100, score: Infinity, depth: 3, comment: "" },
      { usi: "4g4f", count: 1, score: -100, depth: 30, comment: "" },
      { usi: "5g5f", count: 50, depth: 30, comment: "" },
    ];
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 10 })).toEqual(moves.slice(3));
  });

  it("falls back to count when no move has a finite score", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 1, depth: 30, comment: "" },
      { usi: "2g2f", count: 100, score: NaN, depth: 3, comment: "" },
    ];
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 10 })).toEqual([]);
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 3 })).toEqual(moves);
  });

  it("removes invalid moves before picking the primary move", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 1, score: 200, depth: 3, comment: "" },
      { usi: "2g2f", count: 100, score: 100, depth: 30, comment: "" },
    ];
    const isValid = (move: BookMove) => move.usi !== "7g7f";
    // 7g7f is invalid, so the primary move becomes the deep 2g2f.
    expect(filterBookMoves(moves, { ...options, bookDepthLimit: 10 }, isValid)).toEqual([moves[1]]);
  });

  it("filters moves below the turn's minimum evaluation", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", score: 100, comment: "" },
      { usi: "2g2f", score: -50, comment: "" },
    ];
    expect(filterBookMoves(moves, { ...options, minEvalBlack: 0 })).toEqual([moves[0]]);
  });

  it("excludes moves without a finite score only when an evaluation limit applies", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 100, comment: "" },
      { usi: "2g2f", count: 1, score: 0, comment: "" },
      { usi: "3g3f", count: 100, score: NaN, comment: "" },
    ];
    expect(filterBookMoves(moves, { ...options, minEvalWhite: 0 })).toEqual(moves);
    expect(filterBookMoves(moves, { ...options, minEvalBlack: 0 })).toEqual([moves[1]]);
    expect(filterBookMoves(moves, { ...options, maxEvalDiff: 0 })).toEqual([moves[1]]);
  });

  it("measures maxEvalDiff from the highest score, regardless of count", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 100, score: -100, comment: "" },
      { usi: "2g2f", count: 1, score: 500, comment: "" },
      { usi: "3g3f", count: 1, score: 450, comment: "" },
    ];
    expect(filterBookMoves(moves, { ...options, maxEvalDiff: 0 })).toEqual([moves[1]]);
    expect(filterBookMoves(moves, { ...options, maxEvalDiff: 50 })).toEqual(moves.slice(1));
  });

  it("rejects the entry if the highest-scored move is shallow even with a maxEvalDiff", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 100, score: 470, depth: 30, comment: "" },
      { usi: "2g2f", count: 1, score: 500, depth: 3, comment: "" },
      { usi: "3g3f", count: 10, score: 435, depth: 30, comment: "" },
    ];
    const limits = { ...options, maxEvalDiff: 50 };
    expect(filterBookMoves(moves, limits)).toEqual(moves.slice(0, 2));
    expect(filterBookMoves(moves, { ...limits, bookDepthLimit: 10 })).toEqual([]);
  });

  it.each([{ minEvalBlack: 0 }, { maxEvalDiff: 50 }])(
    "uses the depth of the primary move after applying evaluation limits (%j)",
    (evalLimits) => {
      const lowScore = { usi: "7g7f", count: 100, score: -300, comment: "" };
      const highScore = { usi: "2g2f", count: 1, score: 100, comment: "" };
      const limits = { ...options, ...evalLimits, bookDepthLimit: 10 };
      const shallow = { ...highScore, depth: 3 };
      const deep = { ...highScore, depth: 30 };
      expect(filterBookMoves([{ ...lowScore, depth: 30 }, shallow], limits)).toEqual([]);
      expect(filterBookMoves([{ ...lowScore, depth: 3 }, deep], limits)).toEqual([deep]);
    },
  );

  it("ignores the book at the configured rate", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const moves: BookMove[] = [{ usi: "7g7f", score: 100, comment: "" }];
    expect(filterBookMoves(moves, { ...options, ignoreRate: 100 })).toEqual([]);
  });
});

describe("selectBookMove", () => {
  const options = {
    moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_COUNT,
    scoreTemperature: 50,
    turn: Color.BLACK,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects uniformly among the given moves", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", score: 100, comment: "" },
      { usi: "2g2f", score: 200, comment: "" },
    ];
    vi.spyOn(Math, "random").mockReturnValue(0.6);
    expect(
      selectBookMove(moves, { ...options, moveSelectionRule: BookMoveSelectionRule.UNIFORM }),
    ).toBe(moves[1]);
  });

  it("skips zero-count moves when weighting by count", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 0, score: 100, comment: "" },
      { usi: "2g2f", count: 100, score: 200, comment: "" },
    ];
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(selectBookMove(moves, options)).toBe(moves[1]);
  });

  it("excludes moves without a finite score from the score softmax", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 100, comment: "" },
      { usi: "2g2f", count: 1, score: 0, comment: "" },
      { usi: "5g5f", count: 100, score: NaN, comment: "" },
    ];
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(
      selectBookMove(moves, {
        ...options,
        moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_SCORE,
      }),
    ).toBe(moves[1]);
  });

  it("returns the first move when no score is available", () => {
    const moves: BookMove[] = [
      { usi: "7g7f", count: 1, comment: "" },
      { usi: "2g2f", count: 100, comment: "" },
    ];
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(
      selectBookMove(moves, {
        ...options,
        moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_SCORE,
      }),
    ).toBe(moves[0]);
  });
});
