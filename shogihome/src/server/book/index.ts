import fs, { ReadStream } from "node:fs";
import path from "node:path";
import { BookImportSummary, BookLoadingOptions, BookMove as CommonBookMove } from "@/common/book";
import { getAppLogger } from "@/node/log";
import { Book, BookEntry, BookFormat, BookMove, mergeBookEntries } from "./types.js";
import {
  loadYaneuraOuBook,
  mergeYaneuraOuBook,
  searchYaneuraOuBookMovesOnTheFly,
  storeYaneuraOuBook,
  validateBookPositionOrdering,
} from "./yaneuraou.js";
import { BookImportSettings, PlayerCriteria, SourceType } from "@/common/settings/book";
import {
  detectRecordFileFormatByPath,
  importRecordFromBuffer,
  RecordFileFormat,
} from "@/common/file/record";
import { TextDecodingRule } from "@/common/settings/app";
import { loadAppSettings } from "@/server/settings";
import {
  Color,
  getBlackPlayerName,
  getWhitePlayerName,
  ImmutableNode,
  Move,
  Record,
  reverseColor,
  SpecialMoveType,
} from "tsshogi";
import { t } from "@/common/i18n/index";
import { hash as aperyHash } from "./apery_zobrist.js";
import {
  loadAperyBook,
  mergeAperyBook,
  searchAperyBookMovesOnTheFly,
  storeAperyBook,
} from "./apery.js";
import { writeStreamAtomic } from "@/server/file/atomic_stream";
import {
  loadSbkBook,
  loadSbkBookOnTheFly,
  searchSbkBookEntryOnTheFly,
  storeSbkBook,
} from "./sbk.js";

type BookHandle = InMemoryBook | OnTheFlyBook;

type InMemoryBook = Book & {
  type: "in-memory";
  saved: boolean;
  busy: boolean;
};

type OnTheFlyBook = Book & {
  type: "on-the-fly";
  path: string;
  file?: fs.promises.FileHandle;
  size: number;
  saved: boolean;
  busy: boolean;
};

const MAX_SBK_BOOK_SIZE_BYTES = 128 * 1024 * 1024;

function isPathInsideDirectory(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveExistingPathInsideRoot(
  rootDirectory: string,
  targetPath: string,
): Promise<string> {
  const rootPath = path.resolve(rootDirectory);
  const resolvedTarget = path.resolve(targetPath);
  if (!isPathInsideDirectory(rootPath, resolvedTarget)) {
    throw new Error("Forbidden path: " + resolvedTarget);
  }
  // codeql[js/path-injection]
  const stat = await fs.promises.lstat(resolvedTarget);
  if (stat.isSymbolicLink()) {
    throw new Error("Forbidden path: " + resolvedTarget);
  }
  return resolvedTarget;
}

async function listFilesInsideRoot(rootDirectory: string, dir: string): Promise<string[]> {
  const rootPath = path.resolve(rootDirectory);
  const dirPath = await resolveExistingPathInsideRoot(rootPath, dir);
  const files: string[] = [];

  async function visit(currentDir: string): Promise<void> {
    // codeql[js/path-injection]
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      // codeql[js/path-injection]
      const stat = await fs.promises.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      const resolvedEntryPath = path.resolve(entryPath);
      if (!isPathInsideDirectory(rootPath, resolvedEntryPath)) {
        continue;
      }
      if (stat.isFile()) {
        files.push(resolvedEntryPath);
      } else if (stat.isDirectory()) {
        await visit(resolvedEntryPath);
      }
    }
  }

  await visit(dirPath);
  return files;
}

// マージ済みのエントリーを取得する。
async function retrieveMergedEntry(book: BookHandle, sfen: string): Promise<BookEntry | undefined> {
  switch (book.format) {
    case "yane2016": {
      const entry = book.entries.get(sfen);
      if (book.type === "in-memory" || entry?.type === "normal") {
        return entry;
      }
      const base = await searchYaneuraOuBookMovesOnTheFly(sfen, book.file!, book.size);
      return mergeBookEntries(base, entry);
    }
    case "apery": {
      const entry = book.entries.get(aperyHash(sfen));
      if (book.type === "in-memory" || entry?.type === "normal") {
        return entry;
      }
      const base = await searchAperyBookMovesOnTheFly(sfen, book.file!, book.size);
      return mergeBookEntries(base, entry);
    }
    case "sbk":
      if (book.type === "in-memory") {
        return book.entries.get(sfen);
      }
      if (!book.rawData || !book.sbkIndex) {
        return book.entries.get(sfen);
      }
      return mergeBookEntries(
        await searchSbkBookEntryOnTheFly(sfen, book.rawData, book.sbkIndex),
        book.entries.get(sfen),
      );
  }
}

function storeEntry(book: BookHandle, sfen: string, entry: BookEntry): void {
  switch (book.format) {
    case "yane2016":
    case "sbk":
      book.entries.set(sfen, entry);
      break;
    case "apery":
      book.entries.set(aperyHash(sfen), entry);
      break;
  }
  book.saved = false;
}

function emptyBook(format: BookFormat = "yane2016"): BookHandle {
  if (format === "apery") {
    return {
      type: "in-memory",
      format: "apery",
      entries: new Map<bigint, BookEntry>(),
      saved: true,
      busy: false,
    };
  }
  if (format === "sbk") {
    return {
      type: "in-memory",
      format: "sbk",
      entries: new Map<string, BookEntry>(),
      saved: true,
      busy: false,
    };
  }
  return {
    type: "in-memory",
    format: "yane2016",
    entries: new Map<string, BookEntry>(),
    saved: true,
    busy: false,
  };
}

const bookFiles = new Map<number, BookHandle>();
let nextBookSession = 100;

function getBook(session: number): BookHandle {
  const book = bookFiles.get(session);
  if (!book) {
    throw new Error("Book session not found: " + session);
  }
  return book;
}

export function isBookUnsaved(session: number): boolean {
  const book = getBook(session);
  return !book.saved;
}

export function isBookOnTheFly(session: number): boolean {
  const book = getBook(session);
  return book.type === "on-the-fly";
}

export function getBookFormat(session: number): BookFormat {
  const book = getBook(session);
  return book.format;
}

function getFormatByPath(path: string): BookFormat {
  if (path.endsWith(".db")) {
    return "yane2016";
  }
  if (path.endsWith(".sbk")) {
    return "sbk";
  }
  return "apery";
}

async function openBookOnTheFly(session: number, path: string, size: number): Promise<void> {
  getAppLogger().info("Loading book on-the-fly: path=%s size=%d", path, size);
  const format = getFormatByPath(path);
  if (format === "sbk") {
    replaceBook(session, {
      type: "on-the-fly",
      path,
      size,
      saved: true,
      busy: false,
      ...(await loadSbkBookOnTheFly(path)),
    });
    return;
  }
  const file = await fs.promises.open(path, "r");
  try {
    if (
      format === "yane2016" &&
      !(await validateBookPositionOrdering(file.createReadStream({ autoClose: false })))
    ) {
      throw new Error("Book is not ordered by position"); // FIXME: i18n
    }
  } catch (e) {
    await file.close();
    throw e;
  }
  const common = { path, file, size, saved: true, busy: false };
  if (format === "yane2016") {
    replaceBook(session, {
      ...common,
      type: "on-the-fly",
      format: "yane2016",
      entries: new Map<string, BookEntry>(),
    });
  } else {
    replaceBook(session, {
      ...common,
      type: "on-the-fly",
      format: "apery",
      entries: new Map<bigint, BookEntry>(),
    });
  }
}

async function openBookInMemory(session: number, path: string, size: number): Promise<void> {
  getAppLogger().info("Loading book in-memory: path=%s size=%d", path, size);
  let file: ReadStream | undefined;
  try {
    let book: Book;
    switch (getFormatByPath(path)) {
      case "yane2016":
        file = fs.createReadStream(path, { encoding: "utf-8", highWaterMark: 1024 * 1024 });
        book = await loadYaneuraOuBook(file);
        break;
      case "sbk": {
        if (size > MAX_SBK_BOOK_SIZE_BYTES) {
          throw new Error(`SBK file too large: ${size} bytes`);
        }
        const data = await fs.promises.readFile(path);
        book = loadSbkBook(data);
        break;
      }
      case "apery":
        file = fs.createReadStream(path, { highWaterMark: 1024 * 1024 });
        book = await loadAperyBook(file);
        break;
    }
    replaceBook(session, {
      type: "in-memory",
      saved: true,
      busy: false,
      ...book,
    });
  } finally {
    file?.close();
  }
}

export async function openBook(
  session: number,
  path: string,
  options?: BookLoadingOptions,
): Promise<"in-memory" | "on-the-fly"> {
  const stat = await fs.promises.lstat(path);
  if (!stat.isFile()) {
    throw new Error("Not a file: " + path);
  }

  const size = stat.size;
  const format = getFormatByPath(path);
  const thresholdMB =
    format === "sbk" ? options?.sbkOnTheFlyThresholdMB : options?.onTheFlyThresholdMB;
  if (
    options?.forceOnTheFly ||
    (thresholdMB !== undefined && size > thresholdMB * 1024 * 1024) ||
    (format === "sbk" && size > MAX_SBK_BOOK_SIZE_BYTES)
  ) {
    await openBookOnTheFly(session, path, size);
    return "on-the-fly";
  } else {
    await openBookInMemory(session, path, size);
    return "in-memory";
  }
}

export async function openBookAsNewSession(
  path: string,
  options?: BookLoadingOptions,
): Promise<{ session: number; mode: "in-memory" | "on-the-fly" }> {
  const session = nextBookSession++;
  const mode = await openBook(session, path, options);
  return { session, mode };
}

export function initBookSession(session: number): void {
  if (!bookFiles.has(session)) {
    bookFiles.set(session, emptyBook());
  }
}

export function closeBookSession(session: number): void {
  clearBook(session);
  bookFiles.delete(session);
}

function replaceBook(session: number, newBook: BookHandle) {
  clearBook(session);
  bookFiles.set(session, newBook);
}

export async function saveBook(session: number, filePath: string) {
  const book = getBook(session);
  if (book.busy) {
    throw new Error(t.processingPleaseWait);
  }
  // on-the-fly の場合は上書きを禁止
  if (book.type === "on-the-fly") {
    if (path.resolve(book.path) === path.resolve(filePath)) {
      throw new Error(t.cannotOverwriteOnTheFlyBook);
    }
  }

  book.busy = true;
  try {
    await writeStreamAtomic(
      filePath,
      async (file) => {
        switch (book.format) {
          case "yane2016":
            if (!filePath.endsWith(".db")) {
              throw new Error("Invalid file extension: " + filePath);
            }
            if (book.type === "in-memory") {
              await storeYaneuraOuBook(book, file);
            } else {
              const input = book.file!.createReadStream({
                encoding: "utf-8",
                autoClose: false,
                start: 0,
                highWaterMark: 1024 * 1024,
              });
              await mergeYaneuraOuBook(input, book, file);
            }
            break;
          case "apery":
            if (!filePath.endsWith(".bin")) {
              throw new Error("Invalid file extension: " + filePath);
            }
            if (book.type === "in-memory") {
              await storeAperyBook(book, file);
            } else {
              const input = book.file!.createReadStream({
                autoClose: false,
                start: 0,
                highWaterMark: 1024 * 1024,
              });
              await mergeAperyBook(input, book, file);
            }
            break;
          case "sbk":
            if (!filePath.endsWith(".sbk")) {
              throw new Error("Invalid file extension: " + filePath);
            }
            await storeSbkBook(book, file);
            break;
        }
      },
      {
        encoding: "utf-8",
        highWaterMark: 1024 * 1024,
      },
    );
    book.saved = true;
  } finally {
    book.busy = false;
  }
}

export function clearBook(session: number, format?: BookFormat): void {
  const book = bookFiles.get(session);
  if (!book) {
    return;
  }
  if (book.type === "on-the-fly") {
    book.file?.close();
  }
  bookFiles.set(session, emptyBook(format));
}

export async function searchBookMoves(session: number, sfen: string): Promise<CommonBookMove[]> {
  const book = getBook(session);
  const entry = await retrieveMergedEntry(book, sfen);
  return entry ? entry.moves.map((move) => ({ ...move })) : [];
}

function updateBookEntry(entry: BookEntry, move: CommonBookMove): void {
  const bookMove = { ...move };
  for (let i = 0; i < entry.moves.length; i++) {
    if (entry.moves[i].usi === move.usi) {
      entry.moves[i] = bookMove;
      return;
    }
  }
  entry.moves.push(bookMove);
}

export async function updateBookMove(session: number, sfen: string, move: CommonBookMove) {
  const book = getBook(session);
  if (book.busy) {
    throw new Error(t.processingPleaseWait);
  }
  const entry = await retrieveMergedEntry(book, sfen);
  if (book.format === "yane2016" || book.format === "sbk") {
    if (entry) {
      updateBookEntry(entry, move);
      book.entries.set(sfen, entry);
    } else {
      book.entries.set(sfen, {
        type: "normal",
        comment: "",
        moves: [{ ...move }],
        minPly: 0,
      });
    }
  } else {
    const sanitizedMove = {
      score: 0, // required for Apery book
      count: 0, // required for Apery book
      ...move,
      comment: "", // not supported
    };
    delete sanitizedMove.usi2; // not supported
    delete sanitizedMove.depth; // not supported
    delete sanitizedMove.evaluation; // not supported
    const hash = aperyHash(sfen);
    if (entry) {
      updateBookEntry(entry, sanitizedMove);
      book.entries.set(hash, entry);
    } else {
      book.entries.set(hash, {
        type: "normal",
        comment: "",
        moves: [{ ...sanitizedMove }],
        minPly: 0,
      });
    }
  }
  book.saved = false;
}

export async function removeBookMove(session: number, sfen: string, usi: string) {
  const book = getBook(session);
  if (book.busy) {
    throw new Error(t.processingPleaseWait);
  }
  const entry = await retrieveMergedEntry(book, sfen);
  if (!entry) {
    return;
  }
  entry.moves = entry.moves.filter((move) => move.usi !== usi);
  storeEntry(book, sfen, entry);
}

export async function updateBookMoveOrder(
  session: number,
  sfen: string,
  usi: string,
  order: number,
) {
  const book = getBook(session);
  if (book.busy) {
    throw new Error(t.processingPleaseWait);
  }
  const entry = await retrieveMergedEntry(book, sfen);
  if (!entry) {
    return;
  }
  const move = entry.moves.find((move) => move.usi === usi);
  if (!move) {
    return;
  }
  entry.moves = entry.moves.filter((move) => move.usi !== usi);
  entry.moves.splice(order, 0, move);
  storeEntry(book, sfen, entry);
}

function getRecordWinner(node: ImmutableNode): Color | undefined {
  let lastNode = node;
  while (lastNode.next) {
    lastNode = lastNode.next;
  }
  const lastMove = lastNode.move;
  if (lastMove instanceof Move) {
    return undefined;
  }
  switch (lastMove.type) {
    case SpecialMoveType.FOUL_WIN:
    case SpecialMoveType.ENTERING_OF_KING:
      return lastNode.nextColor;
    case SpecialMoveType.RESIGN:
    case SpecialMoveType.MATE:
    case SpecialMoveType.TIMEOUT:
    case SpecialMoveType.FOUL_LOSE:
    case SpecialMoveType.TRY:
      return reverseColor(lastNode.nextColor);
    default:
      return undefined;
  }
}

export async function importBookMoves(
  session: number,
  settings: BookImportSettings,
  onProgress?: (progress: number) => void,
  rootDirectory?: string,
): Promise<BookImportSummary> {
  if (!rootDirectory) {
    throw new Error("rootDirectory is required for security in this environment");
  }

  getAppLogger().info("Importing book moves: %s", JSON.stringify(settings));

  const book = getBook(session);
  if (book.busy) {
    throw new Error(t.processingPleaseWait);
  }

  let successFileCount = 0;
  let errorFileCount = 0;
  let skippedFileCount = 0;

  const pendingMoves = new Map<string, Map<string, number>>();
  const pendingStats = new Map<string, { games: number; wonBlack: number; wonWhite: number }>();
  function importMove(node: ImmutableNode, sfen: string, winner?: Color) {
    if (!(node.move instanceof Move)) {
      return;
    }

    // criteria
    if (node.ply < settings.minPly || node.ply > settings.maxPly) {
      return;
    }

    const usi = node.move.usi;
    let moves = pendingMoves.get(sfen);
    if (!moves) {
      moves = new Map<string, number>();
      pendingMoves.set(sfen, moves);
    }
    moves.set(usi, (moves.get(usi) || 0) + 1);

    if (book.format === "sbk") {
      const stats = pendingStats.get(sfen) || { games: 0, wonBlack: 0, wonWhite: 0 };
      stats.games++;
      if (winner === Color.BLACK) {
        stats.wonBlack++;
      } else if (winner === Color.WHITE) {
        stats.wonWhite++;
      }
      pendingStats.set(sfen, stats);
    }
  }

  book.busy = true;
  try {
    const appSettings = await loadAppSettings();

    let paths: string[];
    switch (settings.sourceType) {
      case SourceType.FILE: {
        if (!settings.sourceRecordFile) {
          throw new Error("source record file is not set");
        }
        if (!detectRecordFileFormatByPath(settings.sourceRecordFile)) {
          throw new Error("unknown file format: " + settings.sourceRecordFile);
        }

        let sourcePath: string;
        try {
          sourcePath = await resolveExistingPathInsideRoot(
            rootDirectory,
            settings.sourceRecordFile,
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(t.fileNotFound(settings.sourceRecordFile));
          }
          throw e;
        }
        // codeql[js/path-injection]
        const sourceStat = await fs.promises.lstat(sourcePath);
        if (!sourceStat.isFile()) {
          throw new Error(t.fileNotFound(settings.sourceRecordFile));
        }
        paths = [sourcePath];
        break;
      }
      case SourceType.DIRECTORY: {
        if (!settings.sourceDirectory) {
          throw new Error("source directory is not set");
        }

        let sourceDirectory: string;
        try {
          sourceDirectory = await resolveExistingPathInsideRoot(
            rootDirectory,
            settings.sourceDirectory,
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(t.directoryNotFound(settings.sourceDirectory));
          }
          throw e;
        }
        // codeql[js/path-injection]
        const sourceStat = await fs.promises.lstat(sourceDirectory);
        if (!sourceStat.isDirectory()) {
          throw new Error(t.directoryNotFound(settings.sourceDirectory));
        }
        paths = await listFilesInsideRoot(rootDirectory, sourceDirectory);
        paths = paths.filter(detectRecordFileFormatByPath);
        break;
      }
      default:
        throw new Error("invalid source type");
    }

    for (const recordFilePath of paths) {
      if (onProgress) {
        const progress = (successFileCount + errorFileCount + skippedFileCount) / paths.length;
        onProgress(progress);
      }

      const targetColorSet = {
        [Color.BLACK]: true,
        [Color.WHITE]: true,
      };
      switch (settings.playerCriteria) {
        case PlayerCriteria.BLACK:
          targetColorSet[Color.WHITE] = false;
          break;
        case PlayerCriteria.WHITE:
          targetColorSet[Color.BLACK] = false;
          break;
      }

      let safeRecordFilePath: string;
      try {
        safeRecordFilePath = await resolveExistingPathInsideRoot(rootDirectory, recordFilePath);
      } catch {
        getAppLogger().error("Forbidden path in importBookMoves: %s", recordFilePath);
        errorFileCount++;
        continue;
      }

      getAppLogger().debug("Importing book moves from: %s", safeRecordFilePath);
      const format = detectRecordFileFormatByPath(safeRecordFilePath) as RecordFileFormat;
      // codeql[js/path-injection]
      const sourceData = await fs.promises.readFile(safeRecordFilePath);

      if (format === RecordFileFormat.SFEN) {
        if (settings.playerCriteria === PlayerCriteria.FILTER_BY_NAME && settings.playerName) {
          getAppLogger().debug("Ignoring SFEN file: %s", safeRecordFilePath);
          skippedFileCount++;
          continue; // skip SFEN files when filtering by player name
        }
        const lines = sourceData.toString("utf-8").split(/\r?\n/);
        let hasValidLines = false;
        let invalidLine = "";
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const record = Record.newByUSI(line.trim());
          if (record instanceof Error) {
            invalidLine = line;
            continue;
          }
          hasValidLines = true;
          let winner: Color | undefined;
          let lastPly = Infinity;
          record.forEach((node) => {
            if (node.ply <= lastPly) {
              winner = getRecordWinner(node);
            }
            lastPly = node.ply;
            const prev = node.prev;
            if (prev && targetColorSet[prev.nextColor]) {
              importMove(node, prev.sfen, winner);
            }
          });
        }
        if (hasValidLines) {
          successFileCount++;
        } else if (invalidLine) {
          getAppLogger().debug(
            "Invalid lines found in SFEN file: %s: [%s]",
            safeRecordFilePath,
            invalidLine,
          );
          errorFileCount++;
        } else {
          getAppLogger().debug("No valid lines found in SFEN file: %s", safeRecordFilePath);
          skippedFileCount++;
        }
        continue;
      }

      const record = importRecordFromBuffer(sourceData, format, {
        autoDetect: appSettings.textDecodingRule === TextDecodingRule.AUTO_DETECT,
      });
      if (record instanceof Error) {
        getAppLogger().debug(
          "Failed to import book moves from: %s: %s",
          safeRecordFilePath,
          record,
        );
        errorFileCount++;
        continue;
      }

      if (settings.playerCriteria === PlayerCriteria.FILTER_BY_NAME) {
        const blackPlayerName = getBlackPlayerName(record.metadata)?.toLowerCase();
        const whitePlayerName = getWhitePlayerName(record.metadata)?.toLowerCase();
        if (!settings.playerName) {
          throw new Error("player name is not set");
        }
        if (
          !blackPlayerName ||
          blackPlayerName?.indexOf(settings.playerName.toLowerCase()) === -1
        ) {
          targetColorSet[Color.BLACK] = false;
        }
        if (
          !whitePlayerName ||
          whitePlayerName?.indexOf(settings.playerName.toLowerCase()) === -1
        ) {
          targetColorSet[Color.WHITE] = false;
        }
      }

      const winner = getRecordWinner(record.current);
      record.forEach((node) => {
        const prev = node.prev;
        if (prev && targetColorSet[prev.nextColor]) {
          importMove(node, prev.sfen, winner);
        }
      });
      successFileCount++;
    }

    const sfens = Array.from(pendingMoves.keys());
    const results = new Map<string, BookEntry>();
    let nextIndex = 0;
    const maxConcurrency = book.type === "on-the-fly" ? 16 : 1;
    const concurrency = Math.min(sfens.length, maxConcurrency);
    const worker = async () => {
      while (nextIndex < sfens.length) {
        const i = nextIndex++;
        const sfen = sfens[i];
        const entry = await retrieveMergedEntry(book, sfen);
        if (entry) {
          results.set(sfen, entry);
        }
      }
    };
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    const entriesMap = results;

    let entryCount = 0;
    let duplicateCount = 0;
    for (const [sfen, movesMap] of pendingMoves.entries()) {
      const entry = entriesMap.get(sfen) || {
        type: book.type === "in-memory" ? "normal" : "patch",
        comment: "",
        moves: [],
        minPly: 0,
      };

      const currentMovesMap = new Map<string, BookMove>();
      for (const move of entry.moves) {
        currentMovesMap.set(move.usi, move);
      }

      for (const [usi, count] of movesMap.entries()) {
        const existing = currentMovesMap.get(usi);
        if (existing) {
          duplicateCount += count;
          existing.count = (existing.count || 0) + count;
        } else {
          entryCount++;
          duplicateCount += count - 1;
          const newMove: BookMove = { usi, comment: "", count };
          if (book.format === "apery") {
            newMove.score = 0;
            // usi2, depth, and comment are already undefined/empty in newMove
          }
          currentMovesMap.set(usi, newMove);
        }
      }

      const stats = pendingStats.get(sfen);
      if (stats) {
        entry.games = (entry.games || 0) + stats.games;
        entry.wonBlack = (entry.wonBlack || 0) + stats.wonBlack;
        entry.wonWhite = (entry.wonWhite || 0) + stats.wonWhite;
      }

      entry.moves = Array.from(currentMovesMap.values());
      entry.moves.sort((a, b) => (b.count || 0) - (a.count || 0));
      storeEntry(book, sfen, entry);
    }

    if (book.type === "in-memory") {
      return {
        successFileCount,
        errorFileCount,
        skippedFileCount,
        entryCount,
        duplicateCount,
      };
    }
    return {
      successFileCount,
      errorFileCount,
      skippedFileCount,
    };
  } finally {
    book.busy = false;
  }
}
