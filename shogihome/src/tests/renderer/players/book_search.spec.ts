import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchBookMovesForPlayer } from "@/renderer/players/book_search";
import { Color, Position } from "tsshogi";
import api from "@/renderer/ipc/api";
import { dispatchUSIInfoUpdate, triggerOnStartSearch } from "@/renderer/players/usi_events";
import { BookMoveSelectionRule } from "@/common/settings/usi";
import { flippedSFEN } from "@/common/helpers/sfen";

vi.mock("@/renderer/ipc/api");
vi.mock("@/renderer/players/usi_events");

describe("searchBookMovesForPlayer", () => {
  const mockPosition = new Position();
  const mockSessionID = 1;
  const mockBookSessionID = "book-session-1";
  const mockEngineName = "Test Engine";
  const mockUSI = "position startpos";
  const weightedByCountOptions = {
    moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_COUNT,
    scoreTemperature: 50,
  };
  const uniformOptions = {
    moveSelectionRule: BookMoveSelectionRule.UNIFORM,
    scoreTemperature: 50,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPosition.resetBySFEN("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1");
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should return false when no book moves found", async () => {
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...weightedByCountOptions, turn: Color.BLACK },
      mockUSI,
      vi.fn(),
    );
    expect(result).toBe(false);
  });

  it("should return false when ignoreRate triggers", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 100, comment: "" },
    ]);

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.05);

    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...weightedByCountOptions, ignoreRate: 10, turn: Color.BLACK },
      mockUSI,
      vi.fn(),
    );
    expect(result).toBe(false);
    randomSpy.mockRestore();
  });

  it("should filter moves by minEvalBlack", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 100, comment: "" },
      { usi: "2g2f", score: -50, comment: "" },
      { usi: "3c3d", score: 200, comment: "" },
    ]);

    const onMove = vi.fn();
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...uniformOptions, turn: Color.BLACK, minEvalBlack: 0 },
      mockUSI,
      onMove,
    );

    expect(result).toBe(true);
    expect(onMove).toBeCalledTimes(1);
    const calledMove = onMove.mock.calls[0][0];
    expect(["7g7f", "3c3d"]).toContain(calledMove.usi);
  });

  it("should filter moves by minEvalWhite", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 100, comment: "" },
      { usi: "2g2f", score: -50, comment: "" },
      { usi: "3c3d", score: 200, comment: "" },
    ]);

    mockPosition.resetBySFEN("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1");

    const onMove = vi.fn();
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...uniformOptions, turn: Color.WHITE, minEvalWhite: 0 },
      mockUSI,
      onMove,
    );

    expect(result).toBe(true);
    expect(onMove).toBeCalledTimes(1);
    const calledMove = onMove.mock.calls[0][0];
    expect(["7g7f", "3c3d"]).toContain(calledMove.usi);
  });

  it("should filter moves by maxEvalDiff", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 200, comment: "" },
      { usi: "2g2f", score: 150, comment: "" },
      { usi: "3c3d", score: 50, comment: "" },
    ]);

    const onMove = vi.fn();
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...uniformOptions, turn: Color.BLACK, maxEvalDiff: 100 },
      mockUSI,
      onMove,
    );

    expect(result).toBe(true);
    expect(onMove).toBeCalledTimes(1);
    const calledMove = onMove.mock.calls[0][0];
    expect(["7g7f", "2g2f"]).toContain(calledMove.usi);
  });

  it("should filter moves by maxEvalDiff for White's turn", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 200, comment: "" },
      { usi: "2g2f", score: 150, comment: "" },
      { usi: "3c3d", score: 120, comment: "" },
      { usi: "8c8d", score: -50, comment: "" },
    ]);

    mockPosition.resetBySFEN("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1");

    const onMove = vi.fn();
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...uniformOptions, turn: Color.WHITE, maxEvalDiff: 60 },
      mockUSI,
      onMove,
    );

    expect(result).toBe(true);
    expect(onMove).toBeCalledTimes(1);
    const calledMove = onMove.mock.calls[0][0];
    expect(["7g7f", "2g2f"]).toContain(calledMove.usi);
  });

  it("should search the flipped position when the direct book has no moves", async () => {
    mockPosition.resetBySFEN("lnsgk1snl/1r4gb1/ppppppppp/9/7P1/9/PPPPPPP1P/1B5R1/LNSGKGSNL w - 4");
    (api.searchBookMoves as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { usi: "2g2f", score: -66, depth: 80, comment: "" },
        { usi: "7g7f", score: -200, depth: 80, comment: "" },
      ]);

    const onMove = vi.fn();
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      {
        ...uniformOptions,
        turn: Color.WHITE,
        maxEvalDiff: 50,
        bookDepthLimit: 3,
      },
      mockUSI,
      onMove,
    );

    expect(result).toBe(true);
    expect(api.searchBookMoves).toHaveBeenNthCalledWith(1, mockPosition.sfen, mockBookSessionID);
    expect(api.searchBookMoves).toHaveBeenNthCalledWith(
      2,
      flippedSFEN(mockPosition.sfen),
      mockBookSessionID,
    );
    expect(onMove.mock.calls[0][0].usi).toBe("8c8d");
  });

  it("should filter moves correctly when maxEvalDiff is 0", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 200, comment: "" },
      { usi: "2g2f", score: 200, comment: "" },
      { usi: "3c3d", score: 150, comment: "" },
    ]);

    const onMove = vi.fn();
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...weightedByCountOptions, turn: Color.BLACK, maxEvalDiff: 0 },
      mockUSI,
      onMove,
    );

    expect(result).toBe(true);
    expect(onMove).toBeCalledTimes(1);
    const calledMove = onMove.mock.calls[0][0];
    expect(["7g7f", "2g2f"]).toContain(calledMove.usi);
  });

  it("should return false when all moves are filtered out", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: -200, comment: "" },
      { usi: "2g2f", score: -300, comment: "" },
    ]);

    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...weightedByCountOptions, turn: Color.BLACK, minEvalBlack: 0 },
      mockUSI,
      vi.fn(),
    );
    expect(result).toBe(false);
  });

  it("should filter moves by bookDepthLimit", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 100, depth: 5, comment: "" },
      { usi: "2g2f", score: 200, depth: 10, comment: "" },
      { usi: "3c3d", score: 150, depth: 3, comment: "" },
    ]);

    const onMove = vi.fn();
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...uniformOptions, turn: Color.BLACK, bookDepthLimit: 5 },
      mockUSI,
      onMove,
    );

    expect(result).toBe(true);
    expect(onMove).toBeCalledTimes(1);
    const calledMove = onMove.mock.calls[0][0];
    expect(["7g7f", "2g2f"]).toContain(calledMove.usi);
  });

  it("should allow moves with undefined depth when bookDepthLimit > 0", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 100, depth: 10, comment: "" },
      { usi: "2g2f", score: 200, comment: "" },
    ]);

    const onMove = vi.fn();
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...uniformOptions, turn: Color.BLACK, bookDepthLimit: 5 },
      mockUSI,
      onMove,
    );

    expect(result).toBe(true);
    expect(onMove).toBeCalledTimes(1);
    const calledMove = onMove.mock.calls[0][0];
    expect(["7g7f", "2g2f"]).toContain(calledMove.usi);
  });

  it("should return false when all moves are filtered out by bookDepthLimit", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 100, depth: 2, comment: "" },
      { usi: "2g2f", score: 200, depth: 3, comment: "" },
    ]);

    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...weightedByCountOptions, turn: Color.BLACK, bookDepthLimit: 10 },
      mockUSI,
      vi.fn(),
    );
    expect(result).toBe(false);
  });

  it("should select a move with uniform probability from filtered moves", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", count: 10, score: 100, comment: "" },
      { usi: "2g2f", count: 90, score: 300, comment: "" },
    ]);

    vi.spyOn(Math, "random").mockReturnValue(0.6);
    const onMove = vi.fn();
    await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...uniformOptions, turn: Color.BLACK, minEvalBlack: 0 },
      mockUSI,
      onMove,
    );

    expect(onMove.mock.calls[0][0].usi).toBe("2g2f");
  });

  it("should dispatch USI info for all original book moves", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 100, depth: 10, count: 50, comment: "" },
      { usi: "2g2f", score: 80, depth: 10, count: 30, comment: "" },
    ]);

    await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...weightedByCountOptions, turn: Color.BLACK, minEvalBlack: 90 },
      mockUSI,
      vi.fn(),
    );

    expect(triggerOnStartSearch).toBeCalled();
    expect(dispatchUSIInfoUpdate).toBeCalledTimes(2);
  });

  it("should not select moves with zero count when weighted by count", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", count: 0, score: 100, comment: "" },
      { usi: "2g2f", count: 100, score: 200, comment: "" },
    ]);

    vi.spyOn(Math, "random").mockReturnValue(0);
    const onMove = vi.fn();
    await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { ...weightedByCountOptions, turn: Color.BLACK },
      mockUSI,
      onMove,
    );

    expect(onMove.mock.calls[0][0].usi).toBe("2g2f");
  });

  it("should select a move using score softmax with the default temperature", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", count: 1, score: 100, comment: "" },
      { usi: "2g2f", count: 100, score: 0, comment: "" },
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0.9);

    const onMove = vi.fn();
    await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      {
        moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_SCORE,
        scoreTemperature: 50,
        turn: Color.BLACK,
      },
      mockUSI,
      onMove,
    );

    // Weights are 1 and exp(-2), so 0.9 selects the lower-scored move.
    expect(onMove.mock.calls[0][0].usi).toBe("2g2f");
  });

  it("should use the configured score temperature", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", score: 100, comment: "" },
      { usi: "2g2f", score: 0, comment: "" },
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0.8);

    const onMove = vi.fn();
    await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      {
        moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_SCORE,
        scoreTemperature: 100,
        turn: Color.BLACK,
      },
      mockUSI,
      onMove,
    );

    // At temperature 100, the best move has about 73% probability.
    expect(onMove.mock.calls[0][0].usi).toBe("2g2f");
  });

  it("should exclude moves without a finite score from score softmax", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", count: 100, comment: "" },
      { usi: "2g2f", count: 1, score: 0, comment: "" },
      { usi: "5g5f", count: 100, score: NaN, comment: "" },
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0);

    const onMove = vi.fn();
    await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      {
        moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_SCORE,
        scoreTemperature: 50,
        turn: Color.BLACK,
      },
      mockUSI,
      onMove,
    );

    expect(onMove.mock.calls[0][0].usi).toBe("2g2f");
  });

  it("should select the first move when all scores are missing", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", count: 1, comment: "" },
      { usi: "2g2f", count: 100, comment: "" },
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    const onMove = vi.fn();
    await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      {
        moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_SCORE,
        scoreTemperature: 50,
        turn: Color.BLACK,
      },
      mockUSI,
      onMove,
    );

    expect(onMove.mock.calls[0][0].usi).toBe("7g7f");
  });
});
