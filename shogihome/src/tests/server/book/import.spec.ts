import fs from "node:fs";
import path from "node:path";
import { Position, Record } from "tsshogi";
import {
  clearBook,
  closeBookSession,
  importBookMoves,
  initBookSession,
  isBookUnsaved,
  openBook,
  saveBook,
  searchBookMoves,
  updateBookMove,
} from "@/server/book";
import * as apery from "@/server/book/apery_zobrist";
import * as yaneuraou from "@/server/book/yaneuraou";
import { defaultBookImportSettings, SourceType } from "@/common/settings/book";
import { getTempPathForTesting } from "@/tests/helpers/temp";

const limits = vi.hoisted(() => ({
  maxMoves: 1_000,
  maxFiles: 3,
  maxScannedEntries: 10,
  maxTotalBytes: 1_024,
  maxFileBytes: 512,
  maxDepth: 10,
  timeoutMs: 300_000,
}));

vi.mock("@/server/book/import_limits", () => ({ BOOK_IMPORT_LIMITS: limits }));

const session = 789;
const initialSfen = new Position().sfen;
let root: string;

function sourceFile(text: string): string {
  const file = path.join(root, "source.sfen");
  fs.writeFileSync(file, text);
  return file;
}

function importFile(file: string) {
  return importBookMoves(
    session,
    { ...defaultBookImportSettings(), sourceRecordFile: file },
    undefined,
    root,
  );
}

function importDirectory(directory = root) {
  return importBookMoves(
    session,
    {
      ...defaultBookImportSettings(),
      sourceType: SourceType.DIRECTORY,
      sourceDirectory: directory,
    },
    undefined,
    root,
  );
}

function distinctPositions(count: number): string {
  const row = (cells: string) => cells.replace(/\.+/g, (empty) => String(empty.length));
  return Array.from({ length: count }, (_, i) => {
    const advanced = Array.from({ length: 9 }, (_, j) => (i & (1 << j) ? "P" : ".")).join("");
    const original = advanced.replace(/[P.]/g, (cell) => (cell === "P" ? "." : "P"));
    return `position sfen lnsgkgsnl/1r5b1/ppppppppp/9/9/${row(advanced)}/${row(original)}/1B5R1/LNSGKGSNL b - 1 moves 5i6h`;
  }).join("\n");
}

describe("book import limits and scheduling", () => {
  beforeEach(() => {
    Object.assign(limits, {
      maxMoves: 1_000,
      maxFiles: 3,
      maxScannedEntries: 10,
      maxTotalBytes: 1_024,
      maxFileBytes: 512,
      maxDepth: 10,
      timeoutMs: 300_000,
    });
    root = fs.mkdtempSync(path.join(getTempPathForTesting(), "book-import-"));
    initBookSession(session);
    clearBook(session);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.restoreAllMocks();
    closeBookSession(session);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses fixed production limits without adding user settings", async () => {
    const { BOOK_IMPORT_LIMITS } = await vi.importActual<
      typeof import("@/server/book/import_limits")
    >("@/server/book/import_limits");
    expect(BOOK_IMPORT_LIMITS).toEqual({
      maxMoves: 1_000_000,
      maxFiles: 20_000,
      maxScannedEntries: 100_000,
      maxTotalBytes: 1_280 * 1024 * 1024,
      maxFileBytes: 16 * 1024 * 1024,
      maxDepth: 10,
      timeoutMs: 300_000,
    });
    expect(Object.isFrozen(BOOK_IMPORT_LIMITS)).toBe(true);
  });

  it("accepts one million moves including duplicates and rejects the next move atomically", async () => {
    limits.maxMoves = 1_000_000;
    limits.maxFileBytes = 16 * 1024 * 1024;
    limits.maxTotalBytes = 1_280 * 1024 * 1024;
    const line = `position startpos moves ${new Array(25).fill("5i6h 5a6b 6h5i 6b5a").join(" ")}\n`;
    const text = line.repeat(10_000);
    const file = sourceFile(text);
    await expect(importFile(file)).resolves.toMatchObject({
      successFileCount: 1,
      entryCount: 4,
      duplicateCount: 999_996,
    });
    const before = await searchBookMoves(session, initialSfen);
    await saveBook(session, path.join(root, "before.db"));
    fs.writeFileSync(file, text + "position startpos moves 7g7f\n");
    await expect(importFile(file)).rejects.toMatchObject({ status: 413 });
    expect(await searchBookMoves(session, initialSfen)).toEqual(before);
    expect(isBookUnsaved(session)).toBe(false);
  }, 20_000);

  it("counts only supported files and accepts the exact file limit", async () => {
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "ignored.txt"), "ignored");
    fs.writeFileSync(path.join(root, ".hidden.sfen"), "ignored");
    for (let i = 0; i < limits.maxFiles; i++) {
      fs.writeFileSync(path.join(root, "nested", `${i}.sfen`), "position startpos moves 7g7f\n");
    }
    await expect(importDirectory()).resolves.toMatchObject({ successFileCount: 3 });
    expect(await searchBookMoves(session, initialSfen)).toMatchObject([{ count: 3 }]);
    fs.writeFileSync(path.join(root, "extra.sfen"), "position startpos moves 2g2f\n");
    await expect(importDirectory()).rejects.toMatchObject({ status: 413 });
    expect(await searchBookMoves(session, initialSfen)).toMatchObject([{ count: 3 }]);
  });

  it("keeps a separate scan limit even for ignored entries", async () => {
    limits.maxScannedEntries = 3;
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(root, `${i}.txt`), "ignored");
    await expect(importDirectory()).resolves.toMatchObject({ successFileCount: 0 });
    fs.writeFileSync(path.join(root, "extra.txt"), "ignored");
    await expect(importDirectory()).rejects.toMatchObject({ status: 413 });
    expect(isBookUnsaved(session)).toBe(false);
  });

  it("retains the depth limit independently of file and scan counts", async () => {
    limits.maxDepth = 2;
    const directory = path.join(root, "one", "two");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "source.sfen"), "position startpos moves 7g7f");
    await expect(importDirectory()).resolves.toMatchObject({ successFileCount: 1 });
    const before = await searchBookMoves(session, initialSfen);
    fs.mkdirSync(path.join(directory, "three"));
    await expect(importDirectory()).rejects.toMatchObject({ status: 413 });
    expect(await searchBookMoves(session, initialSfen)).toEqual(before);
  });

  it.each(["maxFileBytes", "maxTotalBytes"] as const)(
    "accepts the exact %s boundary and preserves unsaved edits on overflow",
    async (limit) => {
      await updateBookMove(session, initialSfen, { usi: "9g9f", comment: "edit", count: 7 });
      const before = await searchBookMoves(session, initialSfen);
      const text = "position startpos moves 7g7f\n";
      limits[limit] = Buffer.byteLength(text);
      const file = sourceFile(text);
      await expect(importFile(file)).resolves.toMatchObject({ successFileCount: 1 });
      const imported = await searchBookMoves(session, initialSfen);
      expect(imported).toContainEqual(before[0]);
      fs.writeFileSync(file, text + "\n");
      await expect(importFile(file)).rejects.toMatchObject({ status: 413 });
      expect(await searchBookMoves(session, initialSfen)).toEqual(imported);
      expect(isBookUnsaved(session)).toBe(true);
    },
  );

  it("applies the total byte limit across multiple files", async () => {
    const text = "position startpos moves 7g7f\n";
    limits.maxTotalBytes = Buffer.byteLength(text) * 2;
    for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(root, `${i}.sfen`), text);
    await expect(importDirectory()).resolves.toMatchObject({ successFileCount: 2 });
    const before = await searchBookMoves(session, initialSfen);
    fs.writeFileSync(path.join(root, "extra.sfen"), text);
    await expect(importDirectory()).rejects.toMatchObject({ status: 413 });
    expect(await searchBookMoves(session, initialSfen)).toEqual(before);
  });

  it("yields while collecting SFEN records, including invalid lines", async () => {
    limits.maxFileBytes = limits.maxTotalBytes = 100_000;
    const text = new Array(500).fill("invalid").join("\n") + "\nposition startpos moves 7g7f";
    const file = sourceFile(text);
    const parse = Record.newByUSI;
    let parsedWhenYielded = 0;
    const spy = vi.spyOn(Record, "newByUSI").mockImplementation((line) => {
      if (spy.mock.calls.length === 1) {
        setImmediate(() => (parsedWhenYielded = spy.mock.calls.length));
      }
      return parse(line);
    });
    await importFile(file);
    expect(parsedWhenYielded).toBeGreaterThan(0);
    expect(parsedWhenYielded).toBeLessThan(501);
  });

  it.each(["yane2016", "sbk"] as const)(
    "yields inside a long filtered record and winner lookahead (%s)",
    async (format) => {
      clearBook(session, format);
      limits.maxFileBytes = limits.maxTotalBytes = 10_000;
      const file = sourceFile(
        `position startpos moves ${new Array(100).fill("5i6h 5a6b 6h5i 6b5a").join(" ")}`,
      );
      const parse = Record.newByUSI;
      let visitedLinks = 0;
      let linksWhenYielded = 0;
      vi.spyOn(Record, "newByUSI").mockImplementation((line) => {
        const record = parse(line);
        if (!(record instanceof Error)) {
          const nodes: (typeof record.first)[] = [];
          record.forEach((node) => nodes.push(node));
          for (const node of nodes) {
            const next = node.next;
            Object.defineProperty(node, "next", {
              configurable: true,
              get: () => {
                visitedLinks++;
                return next;
              },
            });
          }
          setImmediate(() => (linksWhenYielded = visitedLinks));
        }
        return record;
      });
      await expect(
        importBookMoves(
          session,
          { ...defaultBookImportSettings(), sourceRecordFile: file, maxPly: 0 },
          undefined,
          root,
        ),
      ).resolves.toMatchObject({ entryCount: 0 });
      expect(linksWhenYielded).toBeGreaterThan(0);
      expect(linksWhenYielded).toBeLessThan(visitedLinks);
      expect(isBookUnsaved(session)).toBe(false);
    },
  );

  it("checks the deadline after yielding even when no moves meet the criteria", async () => {
    limits.maxFileBytes = limits.maxTotalBytes = 10_000;
    const file = sourceFile(
      `position startpos moves ${new Array(100).fill("5i6h 5a6b 6h5i 6b5a").join(" ")}`,
    );
    const start = Date.now();
    let expired = false;
    vi.spyOn(Date, "now").mockImplementation(() => start + (expired ? limits.timeoutMs + 1 : 0));
    const parse = Record.newByUSI;
    vi.spyOn(Record, "newByUSI").mockImplementation((line) => {
      setImmediate(() => (expired = true));
      return parse(line);
    });
    await expect(
      importBookMoves(
        session,
        { ...defaultBookImportSettings(), sourceRecordFile: file, maxPly: 0 },
        undefined,
        root,
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(isBookUnsaved(session)).toBe(false);
  });

  it("yields during in-memory lookup and staging without exposing partial edits", async () => {
    clearBook(session, "apery");
    limits.maxFileBytes = limits.maxTotalBytes = 100_000;
    const file = sourceFile(distinctPositions(300));
    const hash = apery.hash;
    let hashedWhenYielded = 0;
    let savedWhenYielded = false;
    const spy = vi.spyOn(apery, "hash").mockImplementation((sfen) => {
      if (spy.mock.calls.length === 1) {
        setImmediate(() => {
          hashedWhenYielded = spy.mock.calls.length;
          savedWhenYielded = !isBookUnsaved(session);
        });
      }
      return hash(sfen);
    });
    await expect(importFile(file)).resolves.toMatchObject({ entryCount: 300 });
    expect(hashedWhenYielded).toBeGreaterThan(0);
    expect(hashedWhenYielded).toBeLessThan(600);
    expect(savedWhenYielded).toBe(true);
    expect(isBookUnsaved(session)).toBe(true);
  });

  it.each([false, true])(
    "checks the deadline after the last Apery hash without changing the book (unsaved=%s)",
    async (unsaved) => {
      clearBook(session, "apery");
      await updateBookMove(session, initialSfen, { usi: "9g9f", comment: "", count: 7 });
      if (!unsaved) await saveBook(session, path.join(root, "before.bin"));
      const before = await searchBookMoves(session, initialSfen);
      const file = sourceFile("position startpos moves 7g7f 3c3d");
      const hash = apery.hash;
      const start = Date.now();
      let expired = false;
      let hashes = 0;
      vi.spyOn(Date, "now").mockImplementation(() => start + (expired ? limits.timeoutMs + 1 : 0));
      vi.spyOn(apery, "hash").mockImplementation((sfen) => {
        if (++hashes === 4) expired = true;
        return hash(sfen);
      });
      await expect(importFile(file)).rejects.toMatchObject({ status: 413 });
      vi.restoreAllMocks();
      expect(await searchBookMoves(session, initialSfen)).toEqual(before);
      expect(isBookUnsaved(session)).toBe(unsaved);
      await expect(updateBookMove(session, initialSfen, before[0])).resolves.toBeUndefined();
    },
  );

  it.each([false, true])(
    "waits for parallel lookups and discards all staged edits on failure (unsaved=%s)",
    async (unsaved) => {
      limits.maxFileBytes = limits.maxTotalBytes = 100_000;
      const bookPath = path.join(root, "before.db");
      fs.copyFileSync(path.resolve("src/tests/testdata/book/yaneuraou.db"), bookPath);
      await openBook(session, bookPath, { onTheFlyThresholdMB: 0 });
      if (unsaved) {
        await updateBookMove(session, initialSfen, { usi: "9g9f", comment: "edit", count: 8 });
      }
      const before = await searchBookMoves(session, initialSfen);
      expect(before.length).toBeGreaterThan(0);
      const file = sourceFile(distinctPositions(32));
      const search = yaneuraou.searchYaneuraOuBookMovesOnTheFly;
      let calls = 0;
      let slowLookupSettled = false;
      vi.spyOn(yaneuraou, "searchYaneuraOuBookMovesOnTheFly").mockImplementation(
        async (...args) => {
          const call = ++calls;
          if (call === 2) throw new Error("lookup failed");
          if (call === 3) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            slowLookupSettled = true;
          }
          return search(...args);
        },
      );
      await expect(importFile(file)).rejects.toThrow("lookup failed");
      expect(slowLookupSettled).toBe(true);
      vi.restoreAllMocks();
      expect(await searchBookMoves(session, initialSfen)).toEqual(before);
      expect(isBookUnsaved(session)).toBe(unsaved);
      await expect(updateBookMove(session, initialSfen, before[0])).resolves.toBeUndefined();
    },
  );
});
