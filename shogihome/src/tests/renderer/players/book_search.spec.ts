import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchBookMovesForPlayer } from "@/renderer/players/book_search";
import { Color, Position } from "tsshogi";
import api from "@/renderer/ipc/api";
import { dispatchUSIInfoUpdate, triggerOnStartSearch } from "@/renderer/players/usi_events";

vi.mock("@/renderer/ipc/api");
vi.mock("@/renderer/players/usi_events");

describe("searchBookMovesForPlayer", () => {
  const mockPosition = new Position();
  const mockSessionID = 1;
  const mockBookSessionID = "book-session-1";
  const mockEngineName = "Test Engine";
  const mockUSI = "position startpos";

  beforeEach(() => {
    vi.clearAllMocks();
    mockPosition.resetBySFEN("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1");
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return false when no book moves found", async () => {
    const result = await searchBookMovesForPlayer(
      mockSessionID,
      mockPosition,
      mockBookSessionID,
      mockEngineName,
      { considerBookMoveCount: true, turn: Color.BLACK },
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
      { considerBookMoveCount: true, ignoreRate: 10, turn: Color.BLACK },
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
      { considerBookMoveCount: false, turn: Color.BLACK, minEvalBlack: 0 },
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
      { considerBookMoveCount: false, turn: Color.WHITE, minEvalWhite: 0 },
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
      { considerBookMoveCount: false, turn: Color.BLACK, maxEvalDiff: 100 },
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
      { considerBookMoveCount: false, turn: Color.WHITE, maxEvalDiff: 60 },
      mockUSI,
      onMove,
    );

    expect(result).toBe(true);
    expect(onMove).toBeCalledTimes(1);
    const calledMove = onMove.mock.calls[0][0];
    expect(["7g7f", "2g2f"]).toContain(calledMove.usi);
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
      { considerBookMoveCount: true, turn: Color.BLACK, maxEvalDiff: 0 },
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
      { considerBookMoveCount: true, turn: Color.BLACK, minEvalBlack: 0 },
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
      { considerBookMoveCount: false, turn: Color.BLACK, bookDepthLimit: 5 },
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
      { considerBookMoveCount: false, turn: Color.BLACK, bookDepthLimit: 5 },
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
      { considerBookMoveCount: true, turn: Color.BLACK, bookDepthLimit: 10 },
      mockUSI,
      vi.fn(),
    );
    expect(result).toBe(false);
  });

  it("should select a move with uniform probability from filtered moves when considerBookMoveCount is false", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", count: 10, score: 100, comment: "" },
      { usi: "2g2f", count: 90, score: 300, comment: "" },
    ]);

    const onMove = vi.fn();
    let move7g7f = 0;
    let move2g2f = 0;
    for (let i = 0; i < 100; i++) {
      onMove.mockClear();
      await searchBookMovesForPlayer(
        mockSessionID,
        mockPosition,
        mockBookSessionID,
        mockEngineName,
        { considerBookMoveCount: false, turn: Color.BLACK, minEvalBlack: 0 },
        mockUSI,
        onMove,
      );
      const move = onMove.mock.calls[0][0].usi;
      if (move === "7g7f") move7g7f++;
      if (move === "2g2f") move2g2f++;
    }

    expect(move7g7f).toBeGreaterThan(20);
    expect(move2g2f).toBeGreaterThan(20);
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
      { considerBookMoveCount: true, turn: Color.BLACK, minEvalBlack: 90 },
      mockUSI,
      vi.fn(),
    );

    expect(triggerOnStartSearch).toBeCalled();
    expect(dispatchUSIInfoUpdate).toBeCalledTimes(2);
  });

  it("should not select moves with zero count when considerBookMoveCount is true", async () => {
    (api.searchBookMoves as ReturnType<typeof vi.fn>).mockResolvedValue([
      { usi: "7g7f", count: 100, score: 100, comment: "" },
      { usi: "2g2f", count: 0, score: 200, comment: "" },
    ]);

    const onMove = vi.fn();
    for (let i = 0; i < 100; i++) {
      onMove.mockClear();
      await searchBookMovesForPlayer(
        mockSessionID,
        mockPosition,
        mockBookSessionID,
        mockEngineName,
        { considerBookMoveCount: true, turn: Color.BLACK },
        mockUSI,
        onMove,
      );
      const move = onMove.mock.calls[0][0].usi;
      expect(move).toBe("7g7f");
    }
  });
});
