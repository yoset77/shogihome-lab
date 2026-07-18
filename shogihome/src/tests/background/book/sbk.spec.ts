import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  estimateSbkIndexConstructionBytes,
  validateSbkIndexConstructionMemory,
  loadSbkBook,
  loadSbkBookOnTheFly,
  MAX_SBK_BOOK_SIZE_BYTES,
  searchSbkBookEntryOnTheFly,
  storeSbkBook,
} from "@/server/book/sbk";
import { toSbkMove } from "@/server/book/sbk_move";
import { SBook } from "@/server/book/proto/sbk";
import { SbkBook } from "@/server/book/types";
import { Position } from "tsshogi";

describe("background/book/sbk", () => {
  async function loadOnTheFlyFromData(data: Uint8Array): Promise<SbkBook> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shogihome-sbk-"));
    const filePath = path.join(directory, "book.sbk");
    try {
      await fs.promises.writeFile(filePath, data);
      return await loadSbkBookOnTheFly(filePath);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }

  async function storeToData(book: SbkBook): Promise<Uint8Array> {
    const pass = new PassThrough();
    const chunks: Buffer[] = [];
    pass.on("data", (chunk: Buffer) => chunks.push(chunk));
    await storeSbkBook(book, pass);
    return Buffer.concat(chunks);
  }

  const testCases = [
    { input: "shogigui01.sbk", expected: "shogihome01.sbk" },
    { input: "shogigui02.sbk", expected: "shogihome02.sbk" },
    { input: "shogihome01.sbk", expected: "shogihome01.sbk" },
    { input: "shogihome02.sbk", expected: "shogihome02.sbk" },
  ];

  for (const { input, expected } of testCases) {
    it(`${input} -> ${expected}`, async () => {
      const book = loadSbkBook(fs.readFileSync(`src/tests/testdata/book/${input}`));

      const pass = new PassThrough();
      const chunks: Buffer[] = [];
      pass.on("data", (chunk: Buffer) => chunks.push(chunk));
      const finished = new Promise<void>((resolve) => pass.on("finish", resolve));

      await storeSbkBook(book, pass);
      await finished;

      const outputHex = Buffer.concat(chunks).toString("hex");
      const expectedHex = fs.readFileSync(`src/tests/testdata/book/${expected}`).toString("hex");
      expect(outputHex).toBe(expectedHex);
    });
  }

  it("skips invalid SBK moves", () => {
    const data = SBook.encode({
      Author: "",
      Description: "",
      BookStates: [
        {
          Id: 0,
          BoardKey: 0n,
          HandKey: 0,
          Games: 0,
          WonBlack: 0,
          WonWhite: 0,
          Position: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
          Comment: "",
          Moves: [
            {
              Move: (7 << 12) | (6 << 8), // piece type is zero and must be rejected.
              Evaluation: 0,
              Weight: 1,
              NextStateId: -1,
            },
          ],
          Evals: [],
        },
      ],
    }).finish();

    const book = loadSbkBook(data);
    const entry = book.entries.get(
      "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    );
    expect(entry?.moves).toHaveLength(0);
  });

  it("follows SBK transition state IDs instead of array indexes", () => {
    const rootSfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
    const pos = Position.newBySFEN(rootSfen);
    if (!pos) {
      throw new Error("Invalid root SFEN");
    }
    const move = pos.createMoveByUSI("7g7f");
    if (!move || !pos.doMove(move, { ignoreValidation: true })) {
      throw new Error("Invalid test move");
    }
    const childSfen = pos.sfen;

    const rawData = SBook.encode({
      Author: "",
      Description: "",
      BookStates: [
        {
          Id: 10,
          BoardKey: 0n,
          HandKey: 0,
          Games: 1,
          WonBlack: 0,
          WonWhite: 0,
          Position: rootSfen,
          Comment: "",
          Moves: [
            {
              Move: toSbkMove(move),
              Evaluation: 0,
              Weight: 1,
              NextStateId: 20,
            },
          ],
          Evals: [],
        },
        {
          Id: 20,
          BoardKey: 0n,
          HandKey: 0,
          Games: 1,
          WonBlack: 0,
          WonWhite: 0,
          Position: "",
          Comment: "child",
          Moves: [],
          Evals: [],
        },
      ],
    }).finish();

    const book = loadSbkBook(rawData);
    expect(book.entries.get(rootSfen)?.moves[0]?.usi).toBe("7g7f");
    expect(book.entries.get(childSfen)?.comment).toBe("child");
  });

  it("estimates raw, state, move, and evaluation expansion during index construction", () => {
    expect(estimateSbkIndexConstructionBytes(1024, 2, 3, 4)).toBe(
      1024 * 4 + 2 * 256 + 3 * 256 + 4 * 512,
    );
  });

  it("rejects an index estimate above the fixed construction budget", () => {
    expect(() => validateSbkIndexConstructionMemory(MAX_SBK_BOOK_SIZE_BYTES / 3, 1, 0, 0)).toThrow(
      "SBK index construction exceeds memory budget",
    );
  });

  it.each([
    { sourceIds: [], expectedMaxStateId: -1, expectedNewStateId: 0 },
    { sourceIds: [10, 3, 20], expectedMaxStateId: 20, expectedNewStateId: 21 },
  ])(
    "uses max state ID $expectedMaxStateId when extending an on-the-fly book",
    async ({ sourceIds, expectedMaxStateId, expectedNewStateId }) => {
      const rawData = SBook.encode({
        Author: "",
        Description: "",
        BookStates: sourceIds.map((id) => ({
          Id: id,
          BoardKey: 0n,
          HandKey: 0,
          Games: 0,
          WonBlack: 0,
          WonWhite: 0,
          Position: "",
          Comment: "",
          Moves: [],
          Evals: [],
        })),
      }).finish();
      const book = await loadOnTheFlyFromData(rawData);
      const index = book.sbkIndex;
      if (!index) {
        throw new Error("test book was not loaded on-the-fly");
      }
      expect(index).not.toHaveProperty("indexToOffset");
      expect(index).not.toHaveProperty("stateIds");
      expect(index.maxStateId).toBe(expectedMaxStateId);

      const newSfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/P8/1PPPPPPPP/1B5R1/LNSGKGSNL w - 2";
      book.entries.set(newSfen, {
        type: "normal",
        comment: "new state",
        moves: [],
        minPly: 1,
      });

      const stored = SBook.decode(await storeToData(book));
      expect(stored.BookStates.at(-1)?.Id).toBe(expectedNewStateId);
    },
  );

  it("rejects extending an on-the-fly book beyond the int32 state ID range", async () => {
    const rawData = SBook.encode({
      Author: "",
      Description: "",
      BookStates: [
        {
          Id: 2147483647,
          BoardKey: 0n,
          HandKey: 0,
          Games: 0,
          WonBlack: 0,
          WonWhite: 0,
          Position: "",
          Comment: "",
          Moves: [],
          Evals: [],
        },
      ],
    }).finish();
    const book = await loadOnTheFlyFromData(rawData);
    book.entries.set("lnsgkgsnl/1r5b1/ppppppppp/9/9/P8/1PPPPPPPP/1B5R1/LNSGKGSNL w - 2", {
      type: "normal",
      comment: "new state",
      moves: [],
      minPly: 1,
    });

    await expect(storeToData(book)).rejects.toThrow("SBK state ID limit reached");
  });

  it("rejects stream errors while storing", async () => {
    class FailingWritable extends Writable {
      override _write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        callback(new Error("disk full"));
      }
    }

    const book = loadSbkBook(fs.readFileSync("src/tests/testdata/book/shogihome01.sbk"));
    await expect(storeSbkBook(book, new FailingWritable())).rejects.toThrow("disk full");
  });

  it("rejects stream errors emitted before waiting for drain", async () => {
    class EarlyErrorWritable extends Writable {
      override write(
        _chunk: Uint8Array | string,
        _encoding?: BufferEncoding | ((error?: Error | null) => void),
        _callback?: (error?: Error | null) => void,
      ): boolean {
        void _chunk;
        void _encoding;
        void _callback;
        this.emit("error", new Error("early write failure"));
        return false;
      }

      override _write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        callback();
      }
    }

    const book = loadSbkBook(fs.readFileSync("src/tests/testdata/book/shogihome01.sbk"));
    await expect(storeSbkBook(book, new EarlyErrorWritable())).rejects.toThrow(
      "early write failure",
    );
  });

  it("keeps the on-the-fly search index usable while storing", async () => {
    const book = await loadSbkBookOnTheFly("src/tests/testdata/book/shogihome01.sbk");
    const rawData = book.rawData;
    const index = book.sbkIndex;
    if (!rawData || !index) {
      throw new Error("test book was not loaded on-the-fly");
    }
    const rawDataForSearch = rawData;
    const indexForSearch = index;
    const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
    let observedEntry = undefined as Awaited<ReturnType<typeof searchSbkBookEntryOnTheFly>>;

    class SearchDuringWrite extends Writable {
      private searched = false;

      override _write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        if (this.searched) {
          callback();
          return;
        }
        this.searched = true;
        searchSbkBookEntryOnTheFly(sfen, rawDataForSearch, indexForSearch).then(
          (entry) => {
            observedEntry = entry;
            callback();
          },
          (error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }
    }

    await storeSbkBook(book, new SearchDuringWrite());
    expect(observedEntry?.moves.length).toBeGreaterThan(0);
  });

  it("copies unindexed on-the-fly rows without decoding packed SFEN", async () => {
    const rawData = SBook.encode({
      Author: "",
      Description: "",
      BookStates: [
        {
          Id: 0,
          BoardKey: 0n,
          HandKey: 0,
          Games: 1,
          WonBlack: 0,
          WonWhite: 0,
          Position: "",
          Comment: "",
          Moves: [],
          Evals: [],
        },
      ],
    }).finish();
    const book: SbkBook = {
      format: "sbk",
      entries: new Map(),
      rawData,
      sbkIndex: {
        table: new Uint32Array(9),
        rowCount: 1,
        firstNonZeroRow: 1,
        maxStateId: 0,
      },
    };

    const pass = new PassThrough();
    pass.resume();
    await expect(storeSbkBook(book, pass)).resolves.toBeUndefined();
  });
});
