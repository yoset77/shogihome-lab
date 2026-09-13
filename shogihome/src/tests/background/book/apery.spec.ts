import { PassThrough, Readable, Writable } from "node:stream";
import { loadAperyBook, mergeAperyBook, storeAperyBook } from "@/server/book/apery";
import type { BookEntry } from "@/server/book/types";

describe("background/book/apery", () => {
  it("store round-trips many moves without data loss", async () => {
    // 5000 moves exceed the 4096-move write batch threshold so the test
    // exercises multi-flush behavior of the overwrite-save path.
    const moveCount = 5000;
    const entries = new Map<bigint, BookEntry>();
    for (let i = 0; i < moveCount; i++) {
      entries.set(BigInt(i + 1), {
        type: "normal",
        comment: "",
        moves: [{ usi: "7g7f", score: i % 1000, count: i % 100, comment: "" }],
        minPly: 0,
      });
    }

    const pass = new PassThrough();
    const chunks: Buffer[] = [];
    pass.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve) => pass.on("finish", resolve));
    await storeAperyBook({ format: "apery", entries }, pass);
    await finished;

    const data = Buffer.concat(chunks);
    expect(data.length).toBe(moveCount * 16);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.length)).toEqual([65536, moveCount * 16 - 65536]);
    const loaded = await loadAperyBook(Readable.from([data]));
    expect(loaded.entries.size).toBe(moveCount);
    expect(Object.fromEntries(loaded.entries)).toEqual(Object.fromEntries(entries));
  });

  it.each([1, 1024 * 1024])("batches merge at highWaterMark %i", async (highWaterMark) => {
    const entryFor = (score: number): BookEntry => ({
      type: "normal",
      comment: "",
      moves: [{ usi: "7g7f", score, count: 1, comment: "" }],
      minPly: 0,
    });
    const baseEntries = new Map<bigint, BookEntry>();
    for (let i = 1; i <= 5000; i++) {
      baseEntries.set(BigInt(i * 2), entryFor(i));
    }
    const base = new PassThrough();
    const baseChunks: Buffer[] = [];
    base.on("data", (chunk: Buffer) => baseChunks.push(chunk));
    await storeAperyBook({ format: "apery", entries: baseEntries }, base);

    const patches = new Map<bigint, BookEntry>([
      [1n, entryFor(-1)],
      [4n, entryFor(-4)],
      [6n, { ...entryFor(0), moves: [] }],
      [9999n, entryFor(-9999)],
      [10001n, entryFor(-10001)],
    ]);
    const expected = new Map(baseEntries);
    for (const [key, entry] of patches) {
      if (entry.moves.length) {
        expected.set(key, entry);
      } else {
        expected.delete(key);
      }
    }
    const chunks: Buffer[] = [];
    const output = new Writable({
      highWaterMark,
      write(chunk: Buffer, _encoding, callback) {
        // Consume asynchronously to catch reuse of a buffer still owned by the stream.
        setImmediate(() => {
          chunks.push(Buffer.from(chunk));
          callback();
        });
      },
    });
    await mergeAperyBook(
      Readable.from([Buffer.concat(baseChunks)]),
      { format: "apery", entries: patches },
      output,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.length)).toEqual([65536, expected.size * 16 - 65536]);
    const data = Buffer.concat(chunks);
    expect((await loadAperyBook(Readable.from([data]))).entries).toEqual(expected);
    const keys = Array.from({ length: expected.size }, (_, i) => data.readBigUInt64LE(i * 16));
    expect(keys).toEqual(Array.from(expected.keys()).sort((a, b) => (a < b ? -1 : 1)));
  });
});
