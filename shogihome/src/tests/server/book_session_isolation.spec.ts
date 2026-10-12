// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Position } from "tsshogi";
import { emptyUSIEngineExtraBookConfig } from "@/common/settings/usi";
import type { GameBook } from "@/server/game/book";

const config = vi.hoisted(() => ({ directory: "" }));
vi.mock("@/server/config", async (original) => ({
  ...(await original<typeof import("@/server/config")>()),
  get KIFU_DIR() {
    return config.directory;
  },
}));

describe("browser and game book session isolation", () => {
  const sfen = new Position().sfen;
  const browserId = "browser-book";
  const edit = { usi: "2g2f", count: 3, comment: "Unsaved browser edit" };
  let bookAPI: typeof import("@/server/book");
  let manager: typeof import("@/server/bookSessionManager").bookSessionManager;
  let openGameBook: () => Promise<GameBook>;
  let gameBook: GameBook | undefined;

  beforeEach(async () => {
    vi.resetModules();
    config.directory = await fs.mkdtemp(path.join(os.tmpdir(), "book-session-isolation-"));
    await fs.writeFile(
      path.join(config.directory, "game.db"),
      `#YANEURAOU-DB2016 1.00\nsfen ${sfen}\n7g7f 3c3d 100 8 10\n`,
    );
    bookAPI = await import("@/server/book");
    manager = (await import("@/server/bookSessionManager")).bookSessionManager;
    const { GameBook } = await import("@/server/game/book");
    openGameBook = () =>
      GameBook.open({
        ...emptyUSIEngineExtraBookConfig(),
        enabled: true,
        filePath: "server://game.db",
      });
  });

  afterEach(async () => {
    gameBook?.close();
    gameBook = undefined;
    manager?.close(browserId);
    if (config.directory) await fs.rm(config.directory, { recursive: true, force: true });
    config.directory = "";
  });

  function churnBrowserSessions(): void {
    // Keep only one browser session alive while crossing the old ID boundary.
    for (let index = 0; index < 99; index++) {
      manager.get(browserId, true);
      manager.close(browserId);
    }
  }

  it("preserves unsaved browser edits when a game book opens and closes after session churn", async () => {
    churnBrowserSessions();
    const session = manager.get(browserId, true);
    await bookAPI.updateBookMove(session, sfen, edit);
    expect(bookAPI.isBookUnsaved(session)).toBe(true);
    expect(await bookAPI.searchBookMoves(session, sfen)).toEqual([edit]);

    gameBook = await openGameBook();
    expect(bookAPI.isBookUnsaved(session)).toBe(true);
    expect(await bookAPI.searchBookMoves(session, sfen)).toEqual([edit]);

    gameBook.close();
    gameBook = undefined;
    expect(bookAPI.isBookUnsaved(session)).toBe(true);
    expect(await bookAPI.searchBookMoves(session, sfen)).toEqual([edit]);
  });

  it("preserves a running game's book when browser sessions are created, edited and closed", async () => {
    gameBook = await openGameBook();
    const gameMoves = await gameBook.search(sfen);
    expect(gameMoves).toHaveLength(1);
    churnBrowserSessions();

    const session = manager.get(browserId, true);
    expect(await bookAPI.searchBookMoves(session, sfen)).toEqual([]);
    await bookAPI.updateBookMove(session, sfen, edit);
    expect(await gameBook.search(sfen)).toEqual(gameMoves);

    manager.close(browserId);
    expect(await gameBook.search(sfen)).toEqual(gameMoves);
  });
});
