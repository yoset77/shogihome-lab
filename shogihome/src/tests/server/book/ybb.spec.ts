import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadYbbBook,
  mergeYbbBook,
  openYbbBookOnTheFly,
  searchYbbBookMovesOnTheFly,
  storeYbbBook,
  YbbExpansionLimitError,
} from "@/server/book/ybb";
import type { BookEntry } from "@/server/book/types";
import { getTempPathForTesting } from "@/tests/helpers/temp";
import { createDistinctYbbPositions, createYbbWithReferences } from "@/tests/helpers/ybb";
import * as packedSfen from "@/server/book/packed_sfen";
import * as yaneMove from "@/server/book/yane_move";

const ybbPath = path.resolve("src/tests/testdata/book/yaneuraou.ybb");
const tmpdir = path.join(getTempPathForTesting(), "ybb");
const YBB_MAGIC = "YANE-BINBOOK-V1\0";

describe("server/book/ybb", () => {
  beforeAll(() => {
    fs.mkdirSync(tmpdir, { recursive: true });
  });

  it("round-trips yaneuraou.ybb to identical binary", async () => {
    const ybbBook = await loadYbbBook(ybbPath);
    const tmpPath = path.join(tmpdir, "roundtrip.ybb");
    await storeYbbBook(ybbBook.entries, tmpPath);
    const expected = await fs.promises.readFile(ybbPath);
    const actual = await fs.promises.readFile(tmpPath);
    expect(Buffer.compare(actual, expected)).toBe(0);
  });

  it("keeps trailing base records when patches are exhausted first", async () => {
    // Patching only the first record (in packed order) leaves all remaining
    // base records to be copied after the patches run out. This exercises the
    // patch-exhausted merge path of the overwrite-save flow.
    const base = await openYbbBookOnTheFly(ybbPath);
    try {
      const baseBook = await loadYbbBook(ybbPath);
      const firstSfen = baseBook.entries.keys().next().value as string;
      const first = baseBook.entries.get(firstSfen) as BookEntry;
      const patched: BookEntry = {
        type: "normal",
        comment: "",
        moves: [{ usi: "7g7f", score: 99, comment: "" }],
        minPly: first.minPly,
      };
      const tmpPath = path.join(tmpdir, "patch-first.ybb");
      await mergeYbbBook(
        base.file,
        base.recordCount,
        base.flags,
        new Map([[firstSfen, patched]]),
        tmpPath,
      );
      const merged = await loadYbbBook(tmpPath);
      expect(merged.entries.size).toBe(baseBook.entries.size);
      expect(merged.entries.get(firstSfen)?.moves).toEqual(patched.moves);
      for (const [sfen, entry] of baseBook.entries) {
        if (sfen === firstSfen) {
          continue;
        }
        expect(merged.entries.get(sfen)).toEqual(entry);
      }
    } finally {
      await base.file.close();
    }
  });

  it("rejects an impossible record count", async () => {
    const tmpPath = path.join(tmpdir, "invalid-record-count.ybb");
    const data = Buffer.alloc(32);
    data.write(YBB_MAGIC, 0, 16, "ascii");
    data.writeBigUInt64LE(1_000_000_000_000_000n, 16);
    await fs.promises.writeFile(tmpPath, data);

    await expect(loadYbbBook(tmpPath)).rejects.toThrow("recordCount too large");
    await expect(openYbbBookOnTheFly(tmpPath)).rejects.toThrow("recordCount too large");
  });

  it.each([0, -1])("zero-fills depths when upgrading at record %i", async (patchIndex) => {
    const source = await loadYbbBook(ybbPath);
    const entries = new Map<string, BookEntry>(
      Array.from(source.entries, ([sfen, entry]) => [
        sfen,
        {
          ...entry,
          moves: entry.moves.map(({ usi, score, comment }) => ({ usi, score, comment })),
        },
      ]),
    );
    expect(entries.size).toBeGreaterThan(1);
    const basePath = path.join(tmpdir, `no-depth-${patchIndex}.ybb`);
    const outputPath = path.join(tmpdir, `upgraded-${patchIndex}.ybb`);
    await storeYbbBook(entries, basePath);
    const base = await openYbbBookOnTheFly(basePath);
    try {
      expect(base.flags).toBe(0n);
      const [sfen, entry] = Array.from(entries).at(patchIndex)!;
      const patched: BookEntry = {
        ...entry,
        moves: entry.moves.map((move) => ({ ...move, depth: 20 })),
      };
      // Make uninitialized depth bytes deterministic rather than relying on heap contents.
      const allocationSpy = vi
        .spyOn(Buffer, "allocUnsafe")
        .mockImplementation((size) => Buffer.alloc(size, 0xa5));
      try {
        await mergeYbbBook(
          base.file,
          base.recordCount,
          base.flags,
          new Map([[sfen, patched]]),
          outputPath,
        );
      } finally {
        allocationSpy.mockRestore();
      }
      const expected = new Map(entries);
      expected.set(sfen, patched);
      expect((await loadYbbBook(outputPath)).entries).toEqual(expected);
      const expectedPath = path.join(tmpdir, `expected-upgrade-${patchIndex}.ybb`);
      await storeYbbBook(expected, expectedPath);
      expect(await fs.promises.readFile(outputPath)).toEqual(
        await fs.promises.readFile(expectedPath),
      );
    } finally {
      await base.file.close();
    }
  });

  it("rejects a move offset outside the file", async () => {
    const tmpPath = path.join(tmpdir, "invalid-moves-offset.ybb");
    const data = await fs.promises.readFile(ybbPath);
    data.writeBigUInt64LE(1_000_000_000n, 32 + 32);
    await fs.promises.writeFile(tmpPath, data);

    await expect(loadYbbBook(tmpPath)).rejects.toThrow("moves area exceeds file size");
  });

  describe.each([false, true])("move reference budget (depth=%s)", (hasDepth) => {
    it.each([
      { name: "shared range", records: [{ moveCount: 2 }, { moveCount: 2 }], entries: 2 },
      {
        name: "partially overlapping ranges",
        records: [{ moveCount: 2 }, { moveCount: 2, moveOffset: 1 }],
        entries: 3,
      },
      { name: "one entry over budget", records: [{ moveCount: 2 }, { moveCount: 1 }], entries: 2 },
    ])("rejects $name before any position or move decoding", async ({ records, entries }) => {
      // Duplicate SFEN keys must not hide the cost of allocating discarded entries.
      const tmpPath = path.join(tmpdir, "over-budget.ybb");
      await fs.promises.writeFile(tmpPath, createYbbWithReferences(records, entries, hasDepth));
      const positionDecoder = vi.spyOn(packedSfen, "packedSfenToSfen");
      const moveDecoder = vi.spyOn(yaneMove, "fromYaneMove16");
      try {
        await expect(loadYbbBook(tmpPath)).rejects.toBeInstanceOf(YbbExpansionLimitError);
        expect(positionDecoder).not.toHaveBeenCalled();
        expect(moveDecoder).not.toHaveBeenCalled();
      } finally {
        positionDecoder.mockRestore();
        moveDecoder.mockRestore();
      }
    });

    it.each([0, 1])("accepts the budget boundary with %i unused entries", async (unused) => {
      const sfens = createDistinctYbbPositions(2);
      const records = sfens.map((sfen, index) => ({ sfen, moveCount: 1, moveOffset: index }));
      const tmpPath = path.join(tmpdir, "budget-boundary.ybb");
      await fs.promises.writeFile(tmpPath, createYbbWithReferences(records, 2 + unused, hasDepth));
      const book = await loadYbbBook(tmpPath);
      expect(book.entries.size).toBe(2);
      for (const entry of book.entries.values()) expect(entry.moves).toHaveLength(1);
    });

    it("rejects many small references whose cumulative total exceeds the area", async () => {
      const sfens = createDistinctYbbPositions(1000);
      expect(new Set(sfens).size).toBe(1000);
      const records = sfens.map((sfen) => ({ sfen, moveCount: 1000 }));
      const tmpPath = path.join(tmpdir, "cumulative-over-budget.ybb");
      await fs.promises.writeFile(tmpPath, createYbbWithReferences(records, 1000, hasDepth));
      await expect(loadYbbBook(tmpPath)).rejects.toBeInstanceOf(YbbExpansionLimitError);
    });
  });

  it("rejects a 306 KB expansion bomb in a heap-limited subprocess", async () => {
    const sfens = createDistinctYbbPositions(1000);
    const records = sfens.map((sfen) => ({ sfen, moveCount: 65535 }));
    const data = createYbbWithReferences(records, 65535);
    expect(data.length).toBe(306172);
    const tmpPath = path.join(tmpdir, "expansion-bomb.ybb");
    await fs.promises.writeFile(tmpPath, data);
    const child = path.resolve("src/tests/server/book/helpers/ybb_expansion_child.ts");
    const result = await promisify(execFile)(
      process.execPath,
      ["--max-old-space-size=128", "--import", "tsx", child, tmpPath],
      { timeout: 15000, cwd: process.cwd() },
    );
    expect(result.stdout.trim()).toBe("YBB_EXPANSION_REJECTED");
  }, 20000);

  it("keeps on-the-fly reads local to the requested position", async () => {
    const sfens = createDistinctYbbPositions(2);
    const records = sfens.map((sfen) => ({ sfen, moveCount: 2 }));
    const tmpPath = path.join(tmpdir, "shared-on-the-fly.ybb");
    await fs.promises.writeFile(tmpPath, createYbbWithReferences(records, 2));
    const book = await openYbbBookOnTheFly(tmpPath);
    try {
      for (const sfen of sfens) {
        const entry = await searchYbbBookMovesOnTheFly(
          sfen,
          book.file,
          book.size,
          book.recordCount,
          book.flags,
        );
        expect(entry?.moves).toHaveLength(2);
      }
      expect(book.entries.size).toBe(0);
    } finally {
      await book.file.close();
    }
  });
});
