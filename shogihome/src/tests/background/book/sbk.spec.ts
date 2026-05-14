import fs from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { loadSbkBook, storeSbkBook } from "@/server/book/sbk";
import { SBook } from "@/server/book/proto/sbk";

describe("background/book/sbk", () => {
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
});
