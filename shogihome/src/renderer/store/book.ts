import { BookFormat, BookMove, BookMoveEx } from "@/common/book";
import { BookImportSettings } from "@/common/settings/book";
import { t } from "@/common/i18n/index";
import { flippedSFEN, flippedUSIMove } from "@/common/helpers/sfen";
import api from "@/renderer/ipc/api";
import { Lazy } from "@/renderer/helpers/lazy";
import { useAppSettings } from "./settings.js";
import { useBusyState } from "./busy.js";
import { useConfirmationStore } from "./confirm.js";
import { useErrorStore } from "./error.js";
import { useMessageStore } from "./message.js";
import { useToastStore } from "./toast.js";
import { ImmutableRecord } from "tsshogi";
import { reactive, UnwrapNestedRefs } from "vue";

function getBookFormatByPath(path: string): BookFormat {
  if (path.endsWith(".bin")) {
    return "apery";
  }
  if (path.endsWith(".sbk")) {
    return "sbk";
  }
  if (path.endsWith(".ybb")) {
    return "ybb";
  }
  return "yane2016";
}

function getBookExtension(format: BookFormat): string {
  switch (format) {
    case "apery":
      return ".bin";
    case "sbk":
      return ".sbk";
    case "ybb":
      return ".ybb";
    default:
      return ".db";
  }
}

function normalizeBookPath(path: string): string {
  if (!path.startsWith("server://")) {
    return path;
  }
  const segments: string[] = [];
  for (const segment of path.substring(9).split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
    } else {
      segments.push(segment);
    }
  }
  return "server://" + segments.join("/");
}

function flipMove(move: BookMove): BookMove {
  const flippedMove = { ...move, usi: flippedUSIMove(move.usi) };
  if (flippedMove.usi2) {
    flippedMove.usi2 = flippedUSIMove(flippedMove.usi2);
  }
  return flippedMove;
}

export class BookSessionStore {
  path: string | undefined;
  moves: BookMoveEx[] = [];
  closing = false;
  private closed = false;
  private dirty = false;
  private reloadVersion = 0;

  constructor(
    // Undefined means the server's default session which is not bound to any file.
    readonly sessionId?: string,
    path?: string,
  ) {
    this.path = path && normalizeBookPath(path);
  }

  get format(): BookFormat {
    return this.path ? getBookFormatByPath(this.path) : "yane2016";
  }

  get isUnsaved(): boolean {
    return this.dirty;
  }

  async reloadBookMoves(record: ImmutableRecord): Promise<void> {
    if (this.closed || this.closing) {
      return;
    }
    const reloadVersion = ++this.reloadVersion;
    const sfen = record.position.sfen;
    const moves = await this.searchMoves(sfen);
    if (this.closed || reloadVersion !== this.reloadVersion || sfen !== record.position.sfen) {
      return;
    }
    this.moves = moves.map((bookMove) => {
      const position = record.position.clone();
      const move = position.createMoveByUSI(bookMove.usi);
      let repetition = 0;
      if (move) {
        position.doMove(move);
        repetition = record.getRepetitionCount(position);
      }
      return { ...bookMove, repetition } as BookMoveEx;
    });
  }

  clearMoves(): void {
    this.reloadVersion++;
    this.moves = [];
  }

  async searchMoves(sfen: string): Promise<BookMove[]> {
    this.ensureUsable();
    const moves = await api.searchBookMoves(sfen, this.sessionId);
    if (moves.length !== 0 || !useAppSettings().flippedBook) {
      return moves;
    }
    this.ensureUsable();
    return (await api.searchBookMoves(flippedSFEN(sfen), this.sessionId)).map(flipMove);
  }

  async searchMovesBatch(sfens: string[]): Promise<Map<string, BookMove[]>> {
    this.ensureUsable();
    const querySfens = [...sfens];
    if (useAppSettings().flippedBook) {
      sfens.forEach((sfen) => querySfens.push(flippedSFEN(sfen)));
    }
    const results = await api.searchBookMovesBatch(querySfens, this.sessionId);
    const resultMap = new Map(results.map((result) => [result.sfen, result.moves]));
    return new Map(
      sfens.map((sfen) => {
        const moves = resultMap.get(sfen) || [];
        if (moves.length !== 0 || !useAppSettings().flippedBook) {
          return [sfen, moves];
        }
        return [sfen, (resultMap.get(flippedSFEN(sfen)) || []).map(flipMove)];
      }),
    );
  }

  async updateMove(sfen: string, move: BookMove): Promise<void> {
    this.ensureUsable();
    await api.updateBookMove(sfen, move, this.sessionId);
    this.dirty = true;
  }

  async removeMove(sfen: string, usi: string): Promise<void> {
    this.ensureUsable();
    await api.removeBookMove(sfen, usi, this.sessionId);
    this.dirty = true;
  }

  async updateMoveOrder(sfen: string, usi: string, order: number): Promise<void> {
    this.ensureUsable();
    await api.updateBookMoveOrder(sfen, usi, order, this.sessionId);
    this.dirty = true;
  }

  async saveBookFileAs(validatePath: (path: string) => void): Promise<string | undefined> {
    this.ensureUsable();
    const defaultPath = this.path?.startsWith("server://")
      ? this.path.substring(9)
      : "new_book" + getBookExtension(this.format);
    const selectedPath = await api.showSaveBookDialog(defaultPath);
    if (!selectedPath) {
      return;
    }
    const path = normalizeBookPath(selectedPath);
    this.ensureUsable();
    validatePath(path);
    await api.saveBook(path, this.sessionId);
    this.path = path;
    this.dirty = false;
    useToastStore().success(t.bookDataWasSaved);
    return path;
  }

  async importBookMoves(settings: BookImportSettings): Promise<void> {
    this.ensureUsable();
    await api.saveBookImportSettings(settings);
    this.ensureUsable();
    const summary = await api.importBookMoves(settings, this.sessionId);
    if (summary.entryCount === undefined || summary.entryCount > 0) {
      this.dirty = true;
    }
    const items = [
      {
        text: t.file,
        children: [
          `${t.success}: ${summary.successFileCount}`,
          `${t.failed}: ${summary.errorFileCount}`,
          `${t.skipped}: ${summary.skippedFileCount}`,
        ],
      },
    ];
    if (summary.entryCount !== undefined && summary.duplicateCount !== undefined) {
      items.push({
        text: t.moveEntry,
        children: [`${t.new}: ${summary.entryCount}`, `${t.duplicated}: ${summary.duplicateCount}`],
      });
    }
    useMessageStore().enqueue({
      text: t.bookMovesWereImported,
      attachments: [{ type: "list", items }],
    });
  }

  async close(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    if (this.closing || this.closed) {
      return;
    }
    this.closing = true;
    try {
      await api.closeBook(this.sessionId);
      this.closed = true;
      this.clearMoves();
    } finally {
      this.closing = false;
    }
  }

  markUnsaved(): void {
    this.dirty = true;
  }

  reset(): void {
    this.path = undefined;
    this.dirty = false;
    this.clearMoves();
  }

  private ensureUsable(): void {
    if (this.closed || this.closing) {
      throw new Error(t.processingPleaseWait);
    }
  }
}

export type BookSession = Pick<
  BookSessionStore,
  "sessionId" | "path" | "format" | "moves" | "closing" | "isUnsaved"
>;

export class BookStore {
  books: BookSessionStore[] = [];
  activeBookId: string | undefined;
  private defaultSession = new BookSessionStore();
  private openingBooks = new Map<string, Promise<BookSessionStore>>();
  private lazy = new Lazy();
  private reactiveStore: UnwrapNestedRefs<BookStore>;
  private showBookSelectDialogHandler?: () => void;

  constructor(private record: ImmutableRecord) {
    this.reactiveStore = reactive(this);
  }

  get reactive(): UnwrapNestedRefs<BookStore> {
    return this.reactiveStore;
  }

  private get sessions(): BookSessionStore[] {
    return this.books.length === 0 ? [this.defaultSession] : this.books;
  }

  get activeBook(): BookSessionStore {
    return this.books.find((book) => book.sessionId === this.activeBookId) ?? this.defaultSession;
  }

  // These accessors keep the single-book presentation (mobile) on the active session.
  get format(): BookFormat {
    return this.activeBook.format;
  }

  get path(): string | undefined {
    return this.activeBook.path;
  }

  get moves(): BookMoveEx[] {
    return this.activeBook.moves;
  }

  onShowBookSelectDialog(handler: () => void): void {
    this.showBookSelectDialogHandler = handler;
  }

  async openBook(path: string): Promise<BookSessionStore> {
    if (this.books.length === 0 && this.defaultSession.isUnsaved) {
      throw new Error(t.saveOrClearCurrentBookBeforeOpeningAnother);
    }
    path = normalizeBookPath(path);
    const openedBook = this.books.find((book) => book.path === path);
    if (openedBook) {
      if (openedBook.closing) {
        throw new Error(t.processingPleaseWait);
      }
      this.activeBookId = openedBook.sessionId;
      return openedBook;
    }
    const openingBook = this.openingBooks.get(path);
    if (openingBook) {
      const book = await openingBook;
      this.activeBookId = book.sessionId;
      return book;
    }
    const previousActiveBookId = this.activeBookId;
    const opening = this.openNewBook(path, previousActiveBookId);
    this.openingBooks.set(path, opening);
    try {
      return await opening;
    } finally {
      if (this.openingBooks.get(path) === opening) {
        this.openingBooks.delete(path);
      }
    }
  }

  private async openNewBook(
    path: string,
    previousActiveBookId: string | undefined,
  ): Promise<BookSessionStore> {
    const sessionId = await api.openBookAsNewSession(path, {
      onTheFlyThresholdMB: useAppSettings().bookOnTheFlyThresholdMB,
    });
    const book = new BookSessionStore(sessionId, path);
    this.books.push(book);
    this.activeBookId = sessionId;
    // Operate on the reference stored in `books` so that, when the store is
    // reactive, move updates go through the reactive proxy and refresh the UI.
    const target = this.books[this.books.length - 1];
    try {
      await target.reloadBookMoves(this.record);
      return target;
    } catch (error) {
      this.books = this.books.filter((item) => item !== target);
      if (this.activeBookId === sessionId) {
        const previousBook = this.books.find((item) => item.sessionId === previousActiveBookId);
        this.activeBookId = previousBook?.sessionId ?? this.books.at(-1)?.sessionId;
      }
      await target.close().catch(() => undefined);
      throw error;
    }
  }

  async openBookFile(): Promise<void> {
    useBusyState().retain();
    try {
      if (await api.isServerKifuEnabled()) {
        this.showBookSelectDialogHandler?.();
      } else {
        const path = await api.showOpenBookDialog();
        if (path) {
          await this.openBook(path);
        }
      }
    } catch (error) {
      useErrorStore().add(error);
    } finally {
      useBusyState().release();
    }
  }

  setActiveBook(sessionId: string): void {
    const book = this.books.find((item) => item.sessionId === sessionId);
    if (book && !book.closing) {
      this.activeBookId = sessionId;
    }
  }

  async closeBook(sessionId: string): Promise<void> {
    if (useBusyState().isBusy) {
      return;
    }
    const book = this.books.find((item) => item.sessionId === sessionId);
    if (!book || book.closing) {
      return;
    }
    if (book.isUnsaved) {
      useConfirmationStore().show({
        message: t.anyBookMovesAreUnsavedDoYouReallyWantToDiscardThemAndCloseTheBook,
        onOk: () => void this.closeBookNow(book),
      });
      return;
    }
    await this.closeBookNow(book);
  }

  private async closeBookNow(book: BookSessionStore): Promise<void> {
    if (useBusyState().isBusy || book.closing || !this.books.includes(book)) {
      return;
    }
    useBusyState().retain();
    try {
      await book.close();
    } catch (error) {
      useErrorStore().add(error);
      return;
    } finally {
      useBusyState().release();
    }
    this.books = this.books.filter((item) => item !== book);
    if (this.activeBookId === book.sessionId) {
      this.activeBookId = this.books.at(-1)?.sessionId;
    }
    if (this.books.length === 0) {
      try {
        await this.defaultSession.reloadBookMoves(this.record);
      } catch (error) {
        useErrorStore().add(error);
      }
    }
  }

  onChangePosition(record: ImmutableRecord): void {
    this.record = record;
    this.sessions.forEach((book) => {
      book.clearMoves();
    });
    this.lazy.after(() => {
      this.sessions.forEach((book) => {
        book.reloadBookMoves(this.record).catch((error) => useErrorStore().add(error));
      });
    }, 200);
  }

  async reloadBookMoves(): Promise<void> {
    await Promise.all(
      this.sessions.map((book) =>
        book.reloadBookMoves(this.record).catch((error) => useErrorStore().add(error)),
      ),
    );
  }

  async updateMove(sfen: string, move: BookMove, sessionId = this.activeBookId): Promise<void> {
    const book = this.resolveBook(sessionId);
    useBusyState().retain();
    try {
      await book.updateMove(sfen, move);
      await this.reloadEdited(book);
    } finally {
      useBusyState().release();
    }
  }

  removeMove(sfen: string, usi: string, sessionId = this.activeBookId): void {
    let book: BookSessionStore;
    try {
      book = this.resolveBook(sessionId);
    } catch (error) {
      useErrorStore().add(error);
      return;
    }
    useBusyState().retain();
    book
      .removeMove(sfen, usi)
      .then(() => this.reloadEdited(book))
      .catch((error) => useErrorStore().add(error))
      .finally(() => useBusyState().release());
  }

  updateMoveOrder(sfen: string, usi: string, order: number, sessionId = this.activeBookId): void {
    let book: BookSessionStore;
    try {
      book = this.resolveBook(sessionId);
    } catch (error) {
      useErrorStore().add(error);
      return;
    }
    useBusyState().retain();
    book
      .updateMoveOrder(sfen, usi, order)
      .then(() => this.reloadEdited(book))
      .catch((error) => useErrorStore().add(error))
      .finally(() => useBusyState().release());
  }

  async searchMoves(sfen: string, sessionId = this.activeBookId): Promise<BookMove[]> {
    return this.resolveBook(sessionId).searchMoves(sfen);
  }

  async searchMovesBatch(
    sfens: string[],
    sessionId = this.activeBookId,
  ): Promise<Map<string, BookMove[]>> {
    return this.resolveBook(sessionId).searchMovesBatch(sfens);
  }

  importBookMoves(settings: BookImportSettings, sessionId = this.activeBookId): void {
    let book: BookSessionStore;
    try {
      book = this.resolveBook(sessionId);
    } catch (error) {
      useErrorStore().add(error);
      return;
    }
    useBusyState().retain();
    book
      .importBookMoves(settings)
      .then(() => this.reloadEdited(book))
      .catch((error) => useErrorStore().add(error))
      .finally(() => useBusyState().release());
  }

  reset(): void {
    if (useBusyState().isBusy) {
      return;
    }
    const book = this.activeBook;
    useConfirmationStore().show({
      message: t.anyUnsavedDataWillBeLostDoYouReallyWantToResetBookData,
      onOk: () => {
        if ((book.sessionId && !this.books.includes(book)) || book.closing) {
          return;
        }
        useBusyState().retain();
        api
          .clearBook(book.sessionId)
          .then(async () => {
            if (book === this.defaultSession) {
              book.reset();
            } else {
              book.markUnsaved();
            }
            await book.reloadBookMoves(this.record);
          })
          .catch((error) => useErrorStore().add(error))
          .finally(() => useBusyState().release());
      },
    });
  }

  async saveBookFileAs(): Promise<void> {
    if (useBusyState().isBusy) {
      return;
    }
    const book = this.activeBook;
    useBusyState().retain();
    try {
      await this.saveBookFileAsInternal(book);
    } catch (error) {
      useErrorStore().add(error);
    } finally {
      useBusyState().release();
    }
  }

  private async saveBookFileAsInternal(book: BookSessionStore): Promise<void> {
    const path = await book.saveBookFileAs((path) => {
      if (this.books.some((item) => item !== book && item.path === path)) {
        throw new Error(t.selectedBookFileIsAlreadyOpen);
      }
    });
    if (book !== this.defaultSession || !path) {
      return;
    }
    await api.clearBook();
    book.reset();
    await this.openBook(path);
  }

  // Duplicate paths share one session, so only the edited session needs reloading.
  private async reloadEdited(book: BookSessionStore): Promise<void> {
    await book.reloadBookMoves(this.record).catch((error) => useErrorStore().add(error));
  }

  private resolveBook(sessionId: string | undefined): BookSessionStore {
    if (sessionId === undefined) {
      return this.defaultSession;
    }
    const book = this.books.find((item) => item.sessionId === sessionId);
    if (!book) {
      throw new Error(t.bookSessionIsNoLongerAvailable);
    }
    return book;
  }
}

let store: UnwrapNestedRefs<BookStore>;

export function useBookStore(record?: ImmutableRecord): UnwrapNestedRefs<BookStore> {
  if (!store) {
    if (!record) {
      throw new Error("BookStore must be initialized with a record.");
    }
    store = new BookStore(record).reactive;
  }
  return store;
}
