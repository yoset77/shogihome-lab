import api, { API } from "@/renderer/ipc/api";
import { BookSessionStore, BookStore } from "@/renderer/store/book";
import { defaultAppSettings } from "@/common/settings/app";
import { defaultBookImportSettings } from "@/common/settings/book";
import { useAppSettings } from "@/renderer/store/settings";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { t } from "@/common/i18n";
import { Record } from "tsshogi";
import { effect } from "vue";
import { Mocked } from "vitest";

vi.mock("@/renderer/ipc/api.js");

const mockAPI = api as Mocked<API>;
const sfen = "lr5nl/3g1kg2/2n1p1sp1/p1ppspp1p/1p3P1P1/P1PPS1P1P/1PS1P1N2/2GK1G3/LN5RL w Bb 1";
const flippedSfen =
  "lr5nl/3g1kg2/2n1p1sp1/p1p1spp1p/1p1p3P1/P1PPSPP1P/1PS1P1N2/2GK1G3/LN5RL b Bb 1";

describe("store/book", () => {
  afterEach(async () => {
    useConfirmationStore().cancel();
    vi.useRealTimers();
    vi.clearAllMocks();
    await useAppSettings().updateAppSettings(defaultAppSettings());
  });

  it("searches each session with its own ID", async () => {
    mockAPI.searchBookMoves.mockResolvedValue([{ usi: "8a4a", comment: "foo" }]);
    const first = new BookSessionStore("first", "server://first.db");
    const second = new BookSessionStore("second", "server://second.db");

    await expect(first.searchMoves(sfen)).resolves.toEqual([{ usi: "8a4a", comment: "foo" }]);
    await expect(second.searchMoves(sfen)).resolves.toEqual([{ usi: "8a4a", comment: "foo" }]);

    expect(mockAPI.searchBookMoves).toHaveBeenNthCalledWith(1, sfen, "first");
    expect(mockAPI.searchBookMoves).toHaveBeenNthCalledWith(2, sfen, "second");
  });

  it("searches the default session without a session ID", async () => {
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const defaultSession = new BookSessionStore();

    await expect(defaultSession.searchMoves(sfen)).resolves.toEqual([]);
    expect(mockAPI.searchBookMoves).toHaveBeenCalledWith(sfen, undefined);
  });

  it("searches the flipped position in the same session", async () => {
    await useAppSettings().updateAppSettings({ flippedBook: true });
    mockAPI.searchBookMoves
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ usi: "8a4a", comment: "foo" }]);
    const book = new BookSessionStore("book", "server://book.db");

    await expect(book.searchMoves(flippedSfen)).resolves.toEqual([{ usi: "2i6i", comment: "foo" }]);
    expect(mockAPI.searchBookMoves).toHaveBeenNthCalledWith(1, flippedSfen, "book");
    expect(mockAPI.searchBookMoves).toHaveBeenNthCalledWith(2, sfen, "book");
  });

  it("reloads every open book after a position change", async () => {
    vi.useFakeTimers();
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    mockAPI.searchBookMoves.mockResolvedValue([{ usi: "7g7f", comment: "" }]);
    const record = new Record();
    const store = new BookStore(record);
    await store.openBook("server://first.db");
    await store.openBook("server://second.db");
    mockAPI.searchBookMoves.mockClear();

    record.append(record.position.createMoveByUSI("7g7f")!);
    store.onChangePosition(record);
    expect(store.books.every((book) => book.moves.length === 0)).toBe(true);

    vi.advanceTimersByTime(200);
    await vi.runAllTicks();
    await Promise.resolve();

    expect(mockAPI.searchBookMoves).toHaveBeenCalledTimes(2);
    expect(mockAPI.searchBookMoves).toHaveBeenCalledWith(record.position.sfen, "first");
    expect(mockAPI.searchBookMoves).toHaveBeenCalledWith(record.position.sfen, "second");
  });

  it("searches the replaced record after loading another record", async () => {
    vi.useFakeTimers();
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");
    mockAPI.searchBookMoves.mockClear();

    const replaced = new Record();
    replaced.append(replaced.position.createMoveByUSI("7g7f")!);
    store.onChangePosition(replaced);
    vi.advanceTimersByTime(200);
    await vi.runAllTicks();
    await Promise.resolve();

    expect(mockAPI.searchBookMoves).toHaveBeenCalledWith(replaced.position.sfen, "first");
  });

  it("ignores a search result started before the record was replaced", async () => {
    let resolveSearch!: (moves: { usi: string; comment: string }[]) => void;
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValueOnce([]);
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");
    mockAPI.searchBookMoves.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );

    const reload = store.reloadBookMoves();
    store.onChangePosition(new Record());
    resolveSearch([{ usi: "7g7f", comment: "stale" }]);
    await reload;

    expect(store.books[0].moves).toEqual([]);
  });

  it("activates an already open book instead of opening the same path twice", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());
    const first = await store.openBook("server://book.db");
    await store.openBook("server://other.db");

    const reopened = await store.openBook("server://book.db");

    expect(reopened).toBe(first);
    expect(store.books).toHaveLength(2);
    expect(store.activeBookId).toBe("first");
    expect(mockAPI.openBookAsNewSession).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight open for the same path", async () => {
    let resolveOpen!: (sessionId: string) => void;
    mockAPI.openBookAsNewSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());

    const first = store.openBook("server://books/./book.db");
    const second = store.openBook("server://books/book.db");
    resolveOpen("first");
    await Promise.all([first, second]);

    expect(mockAPI.openBookAsNewSession).toHaveBeenCalledTimes(1);
    expect(store.books).toHaveLength(1);
    expect(store.books[0].path).toBe("server://books/book.db");
  });

  it("keeps a successful concurrent open active when another open fails", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    mockAPI.searchBookMoves.mockImplementation(async (_sfen, sessionId) => {
      if (sessionId === "second") {
        throw new Error("search failed");
      }
      return [];
    });
    const store = new BookStore(new Record());

    const results = await Promise.allSettled([
      store.openBook("server://first.db"),
      store.openBook("server://second.db"),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(store.books.map((book) => book.sessionId)).toEqual(["first"]);
    expect(store.activeBookId).toBe("first");
  });

  it("requires unsaved default data to be saved or cleared before opening", async () => {
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());
    await store.updateMove(sfen, { usi: "8a4a", comment: "new" });

    await expect(store.openBook("server://first.db")).rejects.toThrow();

    expect(mockAPI.openBookAsNewSession).not.toHaveBeenCalled();
  });

  it("reports when an external book session is no longer available", async () => {
    const store = new BookStore(new Record());

    await expect(
      store.updateMove(sfen, { usi: "8a4a", comment: "new" }, "missing"),
    ).rejects.toThrow(t.bookSessionIsNoLongerAvailable);
  });

  it("closes only the selected session", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());
    const first = await store.openBook("server://first.db");
    await store.openBook("server://second.db");

    await store.closeBook(first.sessionId!);

    expect(store.books).toHaveLength(1);
    expect(store.books[0].sessionId).toBe("second");
    expect(mockAPI.closeBook).toHaveBeenCalledWith("first");
  });

  it("keeps a session open when closing it fails", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    mockAPI.closeBook.mockRejectedValueOnce(new Error("close failed"));
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");

    await store.closeBook("first");

    expect(store.books).toHaveLength(1);
    expect(store.activeBookId).toBe("first");
  });

  it("confirms before closing a session with unsaved changes", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");
    await store.updateMove(sfen, { usi: "8a4a", comment: "edited" });

    await store.closeBook("first");

    expect(mockAPI.closeBook).not.toHaveBeenCalled();
    expect(store.books).toHaveLength(1);
    useConfirmationStore().ok();
    await vi.waitFor(() => expect(mockAPI.closeBook).toHaveBeenCalledWith("first"));
    await vi.waitFor(() => expect(store.books).toHaveLength(0));
  });

  it("rejects saving over another open book", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    mockAPI.showSaveBookDialog.mockResolvedValue("server://books/../second.db");
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");
    await store.openBook("server://second.db");
    store.setActiveBook("first");

    await store.saveBookFileAs();

    expect(mockAPI.saveBook).not.toHaveBeenCalled();
    expect(store.books.map((book) => book.path)).toEqual([
      "server://first.db",
      "server://second.db",
    ]);
  });

  it("promotes the default session after saving it", async () => {
    mockAPI.showSaveBookDialog.mockResolvedValue("server://new.db");
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("promoted");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());

    await store.activateNewBook();
    await store.saveBookFileAs();

    expect(mockAPI.saveBook).toHaveBeenCalledWith("server://new.db", undefined);
    expect(mockAPI.clearBook).toHaveBeenLastCalledWith(undefined, "yane2016");
    expect(store.activeBookId).toBe("promoted");
    expect(store.path).toBe("server://new.db");
  });

  it("initializes the default session with the configured format before the first edit", async () => {
    await useAppSettings().updateAppSettings({ defaultBookFormat: "sbk" });
    mockAPI.clearBook.mockResolvedValue(undefined);
    mockAPI.updateBookMove.mockResolvedValue(undefined);
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());

    await store.updateMove(sfen, { usi: "7g7f", comment: "" });

    expect(mockAPI.clearBook).toHaveBeenCalledWith(undefined, "sbk");
    expect(mockAPI.updateBookMove).toHaveBeenCalledWith(
      sfen,
      { usi: "7g7f", comment: "" },
      undefined,
    );

    mockAPI.clearBook.mockClear();
    await store.updateMove(sfen, { usi: "2g2f", comment: "" });
    expect(mockAPI.clearBook).not.toHaveBeenCalled();
  });

  it("does not initialize the format for file-bound sessions", async () => {
    await useAppSettings().updateAppSettings({ defaultBookFormat: "sbk" });
    mockAPI.clearBook.mockResolvedValue(undefined);
    mockAPI.updateBookMove.mockResolvedValue(undefined);
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const book = new BookSessionStore("book", "server://book.db");

    await book.updateMove(sfen, { usi: "7g7f", comment: "" });

    expect(mockAPI.clearBook).not.toHaveBeenCalled();
  });

  it("uses the configured format extension for a new book", async () => {
    await useAppSettings().updateAppSettings({ defaultBookFormat: "apery" });
    mockAPI.showSaveBookDialog.mockResolvedValue("server://new_book.bin");
    mockAPI.saveBook.mockResolvedValue(undefined);
    const session = new BookSessionStore();

    const path = await session.saveBookFileAs(() => undefined);

    expect(mockAPI.clearBook).toHaveBeenCalledWith(undefined, "apery");
    expect(mockAPI.showSaveBookDialog).toHaveBeenCalledWith("new_book.bin");
    expect(mockAPI.saveBook).toHaveBeenCalledWith("server://new_book.bin", undefined);
    expect(path).toBe("server://new_book.bin");
  });

  it("keeps the initialized format when the default setting changes", async () => {
    await useAppSettings().updateAppSettings({ defaultBookFormat: "sbk" });
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const session = new BookSessionStore();
    await session.updateMove(sfen, { usi: "7g7f", comment: "" });

    await useAppSettings().updateAppSettings({ defaultBookFormat: "apery" });
    mockAPI.showSaveBookDialog.mockResolvedValue("");
    await session.saveBookFileAs(() => undefined);

    expect(session.format).toBe("sbk");
    expect(mockAPI.showSaveBookDialog).toHaveBeenCalledWith("new_book.sbk");
  });

  it("waits for in-flight default format initialization before updating", async () => {
    await useAppSettings().updateAppSettings({ defaultBookFormat: "sbk" });
    let resolveClear!: () => void;
    mockAPI.clearBook.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClear = resolve;
        }),
    );
    const session = new BookSessionStore();

    const first = session.updateMove(sfen, { usi: "7g7f", comment: "" });
    await vi.waitFor(() => expect(mockAPI.clearBook).toHaveBeenCalledOnce());
    const second = session.updateMove(sfen, { usi: "2g2f", comment: "" });
    await Promise.resolve();
    expect(mockAPI.updateBookMove).not.toHaveBeenCalled();

    resolveClear();
    await Promise.all([first, second]);
    expect(mockAPI.updateBookMove).toHaveBeenCalledTimes(2);
  });

  it("retries default format initialization after a failure", async () => {
    await useAppSettings().updateAppSettings({ defaultBookFormat: "sbk" });
    mockAPI.clearBook.mockRejectedValueOnce(new Error("clear failed")).mockResolvedValueOnce();
    const session = new BookSessionStore();

    await expect(session.updateMove(sfen, { usi: "7g7f", comment: "" })).rejects.toThrow(
      "clear failed",
    );
    await session.updateMove(sfen, { usi: "2g2f", comment: "" });

    expect(mockAPI.clearBook).toHaveBeenCalledTimes(2);
    expect(mockAPI.updateBookMove).toHaveBeenCalledOnce();
  });

  it("activates the new book session while other books are open", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const record = new Record();
    const store = new BookStore(record);
    await store.openBook("server://first.db");

    await store.activateNewBook();

    expect(store.activeBookId).toBeUndefined();
    expect(store.isNewBookOpen).toBe(true);
    expect(store.activeBook).toBe(store.newBook);
    await store.updateMove(sfen, { usi: "7g7f", comment: "" });
    expect(mockAPI.updateBookMove).toHaveBeenCalledWith(
      sfen,
      { usi: "7g7f", comment: "" },
      undefined,
    );
  });

  it("closes the new book session and returns to the previously active book", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");
    await store.openBook("server://second.db");
    store.setActiveBook("first");

    await store.activateNewBook();
    expect(store.activeBookId).toBeUndefined();

    await store.closeNewBook();
    expect(store.isNewBookOpen).toBe(false);
    expect(store.activeBookId).toBe("first");
    expect(mockAPI.clearBook).toHaveBeenLastCalledWith(undefined, "yane2016");
  });

  it("confirms before discarding an unsaved new book", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");
    await store.activateNewBook();
    await store.updateMove(sfen, { usi: "7g7f", comment: "" });
    mockAPI.clearBook.mockClear();

    await store.closeNewBook();

    expect(store.isNewBookOpen).toBe(true);
    expect(mockAPI.clearBook).not.toHaveBeenCalled();
    useConfirmationStore().ok();
    await vi.waitFor(() => expect(store.isNewBookOpen).toBe(false));
    expect(mockAPI.clearBook).toHaveBeenCalledWith(undefined, "yane2016");
  });

  it("reloads the open new book after a position change", async () => {
    vi.useFakeTimers();
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValue([{ usi: "7g7f", comment: "" }]);
    const record = new Record();
    const store = new BookStore(record);
    await store.openBook("server://first.db");
    await store.activateNewBook();
    expect(store.newBook.moves).toHaveLength(1);
    mockAPI.searchBookMoves.mockClear();

    record.append(record.position.createMoveByUSI("7g7f")!);
    store.onChangePosition(record);
    expect(store.newBook.moves).toEqual([]);
    vi.advanceTimersByTime(200);
    await vi.runAllTicks();
    await Promise.resolve();

    expect(mockAPI.searchBookMoves).toHaveBeenCalledWith(record.position.sfen, undefined);
  });

  it("blocks opening a book while the new book session has unsaved changes", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");

    await store.activateNewBook();
    await store.updateMove(sfen, { usi: "7g7f", comment: "" });

    await expect(store.openBook("server://second.db")).rejects.toThrow();
    expect(mockAPI.openBookAsNewSession).toHaveBeenCalledTimes(1);
  });

  it("does not mark an import with no new entries as unsaved", async () => {
    mockAPI.importBookMoves.mockResolvedValue({
      successFileCount: 1,
      errorFileCount: 0,
      skippedFileCount: 0,
      entryCount: 0,
      duplicateCount: 1,
    });
    const book = new BookSessionStore("first", "server://first.db");

    await book.importBookMoves(defaultBookImportSettings());

    expect(book.isUnsaved).toBe(false);
  });

  it("updates the session captured by an edit dialog", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");
    await store.openBook("server://second.db");

    await store.updateMove(sfen, { usi: "8a4a", comment: "edited" }, "first");

    expect(mockAPI.updateBookMove).toHaveBeenCalledWith(
      sfen,
      { usi: "8a4a", comment: "edited" },
      "first",
    );
  });

  it("notifies reactive observers when a book is opened", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValue([{ usi: "7g7f", comment: "" }]);
    const store = new BookStore(new Record()).reactive;
    let observedMoves = 0;
    const runner = effect(() => {
      observedMoves = store.books.reduce((sum, book) => sum + book.moves.length, 0);
    });

    await store.openBook("server://book.db");

    expect(store.books[0].moves).toHaveLength(1);
    expect(observedMoves).toBe(1);
    runner.effect.stop();
  });

  it("updates the path after saving a book file as", async () => {
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    mockAPI.showSaveBookDialog.mockResolvedValue("/tmp/renamed.db");
    const store = new BookStore(new Record());
    await store.openBook("server://first.db");
    mockAPI.showSaveBookDialog.mockClear();

    await store.saveBookFileAs();

    expect(store.activeBook.path).toBe("/tmp/renamed.db");
    expect(mockAPI.showSaveBookDialog).toHaveBeenCalledWith("first.db");
  });

  it("edits only the active session", async () => {
    await useAppSettings().updateAppSettings({ flippedBook: false });
    mockAPI.openBookAsNewSession.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    mockAPI.searchBookMoves.mockResolvedValue([]);
    const record = new Record();
    const store = new BookStore(record);
    await store.openBook("server://book.db");
    await store.openBook("server://other.db");
    store.setActiveBook("first");
    mockAPI.searchBookMoves.mockClear();

    store.removeMove(sfen, "8a4a");
    await vi.waitFor(() =>
      expect(mockAPI.removeBookMove).toHaveBeenCalledWith(sfen, "8a4a", "first"),
    );
    await vi.waitFor(() => expect(mockAPI.searchBookMoves).toHaveBeenCalledTimes(1));

    const positionSfen = record.position.sfen;
    expect(mockAPI.searchBookMoves).toHaveBeenCalledWith(positionSfen, "first");
  });
});
