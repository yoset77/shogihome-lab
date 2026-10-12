// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Position, Record } from "tsshogi";
import { GameBook, searchGameBook } from "@/server/game/book";
import { GamePlayer } from "@/server/game/player";
import { emptyUSIEngineExtraBookConfig, BookMoveSelectionRule } from "@/common/settings/usi";
import type { GameEngine } from "@/server/engine/internal";
import type { SearchHandler } from "@/common/game/player";

const config = vi.hoisted(() => ({ directory: "" }));
vi.mock("@/server/config", async (original) => ({
  ...(await original<typeof import("@/server/config")>()),
  get KIFU_DIR() {
    return config.directory;
  },
}));

describe("server game books", () => {
  const options = {
    ...emptyUSIEngineExtraBookConfig(),
    enabled: true,
    filePath: "server://book.db",
  };
  let book: GameBook;
  beforeEach(async () => {
    config.directory = await fs.mkdtemp(path.join(os.tmpdir(), "game-book-"));
    await fs.writeFile(
      path.join(config.directory, "book.db"),
      `#YANEURAOU-DB2016 1.00\nsfen ${new Position().sfen}\n7g7f 3c3d 100 8 10\n2g2f none 50 12 20\n5i5a none 999 99 1\n`,
    );
    book = await GameBook.open(options);
  });
  afterEach(async () => {
    book?.close();
    vi.restoreAllMocks();
    if (config.directory) await fs.rm(config.directory, { recursive: true, force: true });
    config.directory = "";
  });
  const search = (settings = options, position = new Position()) =>
    searchGameBook(
      book,
      position,
      "position startpos",
      settings,
      new AbortController().signal,
      vi.fn(),
    );

  it("uses owned book storage, excludes illegal moves and preserves weighted selection", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect((await search())?.usi).toBe("2g2f");
    expect(
      (await search({ ...options, moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_SCORE }))
        ?.usi,
    ).toBe("7g7f");
    expect((await search({ ...options, bookDepthLimit: 10 }))?.usi).toBe("2g2f");
    expect((await search({ ...options, ignoreRate: 100 }))?.usi).toBeUndefined();
    expect((await search({ ...options, minEvalBlack: 200 }))?.usi).toBeUndefined();
  });
  it("uses flipped positions only when the original position is absent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const record = Record.newByUSI("position startpos moves 7g7f") as Record;
    const position = record.position;
    const lookup = vi
      .spyOn(book, "search")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ usi: "7g7f", count: 1, comment: "" }]);
    const move = await searchGameBook(
      book,
      position,
      record.usi,
      options,
      new AbortController().signal,
      vi.fn(),
    );
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(move?.usi).toBe("3c3d");
    lookup.mockClear();
    expect(
      await searchGameBook(
        book,
        position,
        record.usi,
        { ...options, maxMoves: 1 },
        new AbortController().signal,
        vi.fn(),
      ),
    ).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
  it("rejects non-server, traversal and wrong-kind book paths", async () => {
    for (const filePath of ["book.db", "server://../book.db", "server://record.kifu"])
      await expect(GameBook.open({ ...options, filePath })).rejects.toThrow();
  });

  const fixture = () => {
    const engine: GameEngine = {
      launch: vi.fn(),
      setMultiPV: vi.fn(),
      readyNewGame: vi.fn(),
      startResearch: vi.fn(),
      startSearch: vi.fn(async () => ({
        finished: new Promise<void>(() => {}),
        stop: vi.fn(),
        cancel: vi.fn(),
      })),
      cancelAll: vi.fn(async () => {}),
      gameover: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const handler: SearchHandler = {
      onMove: vi.fn(),
      onResign: vi.fn(),
      onWin: vi.fn(),
      onError: vi.fn(),
    };
    const player = new GamePlayer(engine, book, options);
    const start = () =>
      player.startSearch(
        new Position(),
        "position startpos",
        {
          black: { timeMs: 30_000, byoyomi: 0, increment: 2 },
          white: { timeMs: 30_000, byoyomi: 0, increment: 2 },
        },
        handler,
      );
    return { player, engine, handler, start };
  };
  it("falls back to timed engine search after a book read failure and closes its owned handle", async () => {
    vi.spyOn(book, "search").mockRejectedValue(new Error("Book read failed"));
    const close = vi.spyOn(book, "close");
    const { player, engine, handler, start } = fixture();
    await start();
    expect(engine.startSearch).toHaveBeenCalledWith(
      "position startpos",
      "go btime 30000 wtime 30000 binc 2000 winc 2000",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(handler.onMove).not.toHaveBeenCalled();
    await player.close();
    await player.close();
    expect(close).toHaveBeenCalledOnce();
  });
  it("cancels a pending book lookup without waiting for stale file results", async () => {
    let complete!: (moves: Awaited<ReturnType<GameBook["search"]>>) => void;
    vi.spyOn(book, "search").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { player, engine, handler, start } = fixture();
    const starting = start();
    const cancelling = player.cancelSearch();
    let cancelled = false;
    void cancelling.then(() => {
      cancelled = true;
    });
    await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 100 });
    complete([{ usi: "7g7f", count: 1, comment: "" }]);
    await starting;
    expect(handler.onMove).not.toHaveBeenCalled();
    expect(engine.startSearch).not.toHaveBeenCalled();
    await player.close();
  });
});
