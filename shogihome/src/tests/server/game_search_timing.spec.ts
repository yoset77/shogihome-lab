// @vitest-environment node
import { Color, Record } from "tsshogi";
import { GameRecord } from "@/common/game/record";
import { defaultGameSettings, type TimeLimitSettings } from "@/common/settings/game";
import { emptyUSIEngineExtraBookConfig } from "@/common/settings/usi";
import { ES_HUMAN } from "@/common/uri";
import type { GameEngine } from "@/server/engine/internal";
import { Clock } from "@/server/game/clock";
import { GameController } from "@/server/game/controller";
import { GamePlayer, HumanPlayer } from "@/server/game/player";
import type { GameBook } from "@/server/game/book";

vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));

async function setup(
  color = Color.BLACK,
  timeLimit: TimeLimitSettings = { timeSeconds: 60, byoyomi: 0, increment: 2 },
  withBook = false,
) {
  let now = 0;
  const black = new Clock(() => now);
  const white = new Clock(() => now);
  const clock = color === Color.BLACK ? black : white;
  const searches: { go: string; timeMs: number; byoyomiMs: number; elapsedMs: number }[] = [];
  const engine: GameEngine = {
    launch: vi.fn(),
    setMultiPV: vi.fn(),
    readyNewGame: vi.fn(),
    startResearch: vi.fn(),
    startSearch: vi.fn(async (_position, go) => {
      expect(clock.running).toBe(true);
      searches.push({ go, ...clock.snapshot() });
      return { finished: new Promise<void>(() => {}), stop: vi.fn(), cancel: vi.fn() };
    }),
    cancelAll: vi.fn(async () => {}),
    gameover: vi.fn(),
    close: vi.fn(async () => {}),
  };
  let finishBook!: (moves: Awaited<ReturnType<GameBook["search"]>>) => void;
  const book = {
    search: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  };
  if (withBook)
    book.search.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBook = resolve;
        }),
    );
  const ai = new GamePlayer(engine, withBook ? (book as unknown as GameBook) : undefined, {
    ...emptyUSIEngineExtraBookConfig(),
    enabled: true,
  });
  const records = new GameRecord(
    Record.newByUSI(
      color === Color.BLACK ? "position startpos" : "position startpos moves 7g7f",
    ) as Record,
  );
  const updates: { running: boolean; searches: number }[] = [];
  const error = vi.fn();
  const game = new GameController(records, black, white).on("error", error).on("update", () => {
    if (!game.isActive) return;
    updates.push({ running: clock.running, searches: searches.length });
    now += 200;
  });
  await game.start(
    {
      ...defaultGameSettings(),
      black: { uri: color === Color.BLACK ? "lan-engine:test" : ES_HUMAN, name: "Black" },
      white: { uri: color === Color.WHITE ? "lan-engine:test" : ES_HUMAN, name: "White" },
      startPosition: "current",
      timeLimit,
      enableAutoSave: false,
      enableComment: false,
      enableEngineTimeout: true,
    },
    { build: async (settings) => (settings.uri === ES_HUMAN ? new HumanPlayer() : ai) },
  );
  await vi.advanceTimersByTimeAsync(0);
  return {
    game,
    engine,
    book,
    records,
    clock,
    searches,
    updates,
    error,
    advance: (ms: number) => {
      now += ms;
    },
    finishBook: (moves: Awaited<ReturnType<GameBook["search"]>>) => finishBook(moves),
  };
}

describe("engine search clock alignment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([Color.BLACK, Color.WHITE])(
    "keeps %s's pre-search update uncharged and publishes clock start after go",
    async (color) => {
      const { game, clock, searches, updates, error } = await setup(color);
      expect(searches).toEqual([
        expect.objectContaining({
          go: "go btime 60000 wtime 60000 binc 2000 winc 2000",
          timeMs: 62_000,
          elapsedMs: 0,
        }),
      ]);
      expect(updates).toEqual([
        { running: false, searches: 0 },
        { running: true, searches: 1 },
      ]);
      expect(clock.timeMs).toBe(61_800);
      expect(error).not.toHaveBeenCalled();
      game.stop();
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it.each([
    { timeSeconds: 60, byoyomi: 0, increment: 2 },
    { timeSeconds: 0, byoyomi: 0, increment: 2 },
    { timeSeconds: 0, byoyomi: 10, increment: 0 },
  ])("does not charge a delayed book miss with $timeSeconds/$byoyomi/$increment", async (time) => {
    const { game, clock, searches, book, finishBook, advance, error } = await setup(
      Color.BLACK,
      time,
      true,
    );
    advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clock.running).toBe(false);
    expect(clock.timeMs).toBe((time.timeSeconds + time.increment) * 1000);
    expect(clock.elapsedMs).toBe(0);
    expect(game.isActive).toBe(true);
    expect(searches).toEqual([]);
    finishBook([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(book.search).toHaveBeenCalledTimes(2);
    expect(searches).toEqual([
      expect.objectContaining({
        timeMs: (time.timeSeconds + time.increment) * 1000,
        byoyomiMs: time.byoyomi * 1000,
        elapsedMs: 0,
      }),
    ]);
    expect(searches[0].go).toBe(
      `go btime ${time.timeSeconds * 1000} wtime ${time.timeSeconds * 1000}` +
        (time.byoyomi
          ? ` byoyomi ${time.byoyomi * 1000}`
          : ` binc ${time.increment * 1000} winc ${time.increment * 1000}`),
    );
    expect(error).not.toHaveBeenCalled();
    game.stop();
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each([0, 60])(
    "credits a completed book move with %ss main time without charging preparation",
    async (timeSeconds) => {
      const { game, clock, records, searches, finishBook, advance } = await setup(
        Color.BLACK,
        { timeSeconds, byoyomi: 0, increment: 2 },
        true,
      );
      advance(5000);
      finishBook([{ usi: "7g7f", count: 1, comment: "" }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(searches).toEqual([]);
      expect(records.record.current.ply).toBe(1);
      expect(records.record.current.elapsedMs).toBe(0);
      expect(clock.timeMs).toBe(timeSeconds * 1000 + 4000);
      expect(clock.running).toBe(false);
      game.stop();
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it("does not resume the clock or send go after cancelling preparation", async () => {
    const { game, engine, clock, finishBook, advance, error } = await setup(
      Color.BLACK,
      undefined,
      true,
    );
    const resume = vi.spyOn(clock, "resume");
    game.stop();
    await vi.advanceTimersByTimeAsync(0);
    advance(5000);
    finishBook([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(resume).not.toHaveBeenCalled();
    expect(engine.startSearch).not.toHaveBeenCalled();
    expect(clock.running).toBe(false);
    expect(clock.timeMs).toBe(62_000);
    expect(clock.elapsedMs).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });
});
