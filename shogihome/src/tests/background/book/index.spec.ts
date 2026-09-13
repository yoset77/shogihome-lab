import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  clearBook,
  closeBookSession,
  getBookFormat,
  importBookMoves,
  openBook,
  openBookAsNewSession,
  removeBookMove,
  saveBook,
  searchBookMoves,
  updateBookMove,
  updateBookMoveOrder,
  initBookSession,
} from "@/server/book/index";
import { loadSbkBook } from "@/server/book/sbk";
import { getTempPathForTesting } from "@/tests/helpers/temp";
import { defaultBookImportSettings, PlayerCriteria, SourceType } from "@/common/settings/book";
import { createTestAperyBookFile } from "@/tests/mock/book";
import { BookFormat, SbkMoveEvaluation, bookFormats } from "@/common/book";

const defaultBookSession = 1;

const tmpdir = path.join(getTempPathForTesting(), "book");

function sha256File(filePath: string) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

describe("background/book", () => {
  beforeAll(() => {
    if (!fs.existsSync(tmpdir)) {
      fs.mkdirSync(tmpdir, { recursive: true });
    }
  });

  beforeEach(() => {
    initBookSession(defaultBookSession);
    clearBook(defaultBookSession);
  });

  it("default book format", () => {
    expect(getBookFormat(defaultBookSession)).toBe("yane2016");
  });

  it("initializes an empty session with each format", async () => {
    const extensions: Record<BookFormat, string> = {
      yane2016: ".db",
      apery: ".bin",
      sbk: ".sbk",
      ybb: ".ybb",
    };
    for (const format of bookFormats) {
      clearBook(defaultBookSession, format);
      expect(getBookFormat(defaultBookSession)).toBe(format);
      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
        { usi: "7g7f", score: 30, count: 1, comment: "" },
      );
      const tempFilePath = path.join(tmpdir, "init-" + format + extensions[format]);
      await saveBook(defaultBookSession, tempFilePath);
      expect(fs.existsSync(tempFilePath)).toBe(true);
      fs.rmSync(tempFilePath, { force: true });
    }
  });

  describe("openBook", () => {
    describe("yaneuraou.db", () => {
      const sources = [
        "src/tests/testdata/book/yaneuraou.db",
        "src/tests/testdata/book/yaneuraou-crlf.db",
        "src/tests/testdata/book/yaneuraou-bom-crlf.db",
        "src/tests/testdata/book/yaneuraou-no-header.db",
        "src/tests/testdata/book/yaneuraou-bom-no-header.db",
      ];
      const patterns = [
        { options: { onTheFlyThresholdMB: 0.001 }, mode: "in-memory" },
        { options: { onTheFlyThresholdMB: 0.0005 }, mode: "on-the-fly" },
      ];
      for (const pattern of patterns) {
        for (const source of sources) {
          it(`mode=${pattern.mode} source=${source}`, async () => {
            const mode = await openBook(defaultBookSession, source, pattern.options);
            expect(mode).toBe(pattern.mode);

            const moves = await searchBookMoves(
              defaultBookSession,
              "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
            );
            expect(moves).toHaveLength(5);
            expect(moves[0].usi).toBe("2g2f");
            expect(moves[0].usi2).toBe("3c3d");
            expect(moves[0].score).toBe(63);
            expect(moves[0].depth).toBe(27);
            expect(moves[1].usi).toBe("7g7f");
            expect(moves[1].usi2).toBeUndefined();
            expect(moves[1].score).toBe(20);
            expect(moves[1].depth).toBe(25);
            expect(moves[2].usi).toBe("5g5f");
            expect(moves[3].usi).toBe("2h7h");
            expect(moves[4].usi).toBe("3g3f");
            const moves2 = await searchBookMoves(
              defaultBookSession,
              "lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1",
            );
            expect(moves2).toHaveLength(3);
            const moves3 = await searchBookMoves(
              defaultBookSession,
              "r6nl/l3gbks1/2ns1g1p1/ppppppp1p/7P1/PSPPPPP1P/1P1G2N1L/1KGB1S2R/LN7 w - 1",
            );
            expect(moves3).toHaveLength(0);
            const moves4 = await searchBookMoves(
              defaultBookSession,
              "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL w - 1",
            );
            expect(moves4).toHaveLength(3);

            // comments
            expect(moves[0].comment).toBe("multi line comment 1\nmulti line comment 2");
            expect(moves[1].comment).toBe("single line comment");
            expect(moves[2].comment).toBe("");
          });
        }
      }

      it("invalid", async () => {
        await expect(
          openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou-invalid-header.db", {
            onTheFlyThresholdMB: 1,
          }),
        ).rejects.toThrow("Unsupported book header: #YANEURAOU-DB2016 2.00");
      });
    });

    describe("apery.bin", () => {
      const patterns = [
        { options: { onTheFlyThresholdMB: 0.001 }, mode: "in-memory" },
        { options: { onTheFlyThresholdMB: 0.00005 }, mode: "on-the-fly" },
      ];
      for (const pattern of patterns) {
        it(`mode=${pattern.mode}`, async () => {
          const mode = await openBook(
            defaultBookSession,
            "src/tests/testdata/book/apery.bin",
            pattern.options,
          );
          expect(mode).toBe(pattern.mode);

          const moves = await searchBookMoves(
            defaultBookSession,
            "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL w - 4",
          );
          expect(moves).toHaveLength(3);
          expect(moves[0].usi).toBe("4c4d");
          expect(moves[0].score).toBe(-30);
          expect(moves[0].count).toBe(69);
          expect(moves[1].usi).toBe("3d3e");
          expect(moves[1].score).toBe(-50);
          expect(moves[1].count).toBe(23);
          expect(moves[2].usi).toBe("2c2d");
          expect(moves[2].score).toBe(-100);
          expect(moves[2].count).toBe(8);

          const singleMoveCases = [
            "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
            "lnsgkgsnl/1r5b1/ppppppppp/9/9/7P1/PPPPPPP1P/1B5R1/LNSGKGSNL w - 2",
            "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/7P1/PPPPPPP1P/1B5R1/LNSGKGSNL b - 3",
            "lnsgkgsnl/1r5b1/pppppp2p/6pp1/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL b - 5",
            "lnsgkgsnl/1r5b1/pppppp2p/6pp1/9/2P4P1/PP1PPPP1P/1B1K3R1/LNSG1GSNL w - 6",
            "lnsgkgsnl/1r5b1/pppp1p2p/4p1pp1/9/2P4P1/PP1PPPP1P/1B1K3R1/LNSG1GSNL b - 7",
            "lnsgkgsnl/1r5b1/pppp1p2p/4p1pp1/7P1/2P6/PP1PPPP1P/1B1K3R1/LNSG1GSNL w - 8",
            "lnsgkgsnl/1r5b1/pppp1p2p/4p1p2/7p1/2P6/PP1PPPP1P/1B1K3R1/LNSG1GSNL b p 9",
            "lnsgkgsnl/1r5b1/pppp1p2p/4p1p2/7R1/2P6/PP1PPPP1P/1B1K5/LNSG1GSNL w Pp 10",
            "lnsgkgsnl/1r7/pppp1p2p/4p1p2/7R1/2P6/PP1PPPP1P/1+b1K5/LNSG1GSNL b Pbp 11",
            "lnsgkgsnl/1r7/pppp1p2p/4p1p2/7R1/2P6/PP1PPPP1P/1S1K5/LN1G1GSNL w BPbp 12",
            "lnsgkgsnl/7r1/pppp1p2p/4p1p2/7R1/2P6/PP1PPPP1P/1S1K5/LN1G1GSNL b BPbp 13",
            "lnsgkgsnl/7r1/pppp1p1Pp/4p1p2/7R1/2P6/PP1PPPP1P/1S1K5/LN1G1GSNL w Bbp 14",
            "lnsgkgsnl/4r4/pppp1p1Pp/4p1p2/7R1/2P6/PP1PPPP1P/1S1K5/LN1G1GSNL b Bbp 15",
            "lnsgkgsnl/4r4/pppp1p1Pp/4p1p2/7R1/2P6/PP1PPPP1P/1SK6/LN1G1GSNL w Bbp 16",
            "lnsgkgsnl/4r4/pppp1p1Pp/4p1p1b/7R1/2P6/PP1PPPP1P/1SK6/LN1G1GSNL b Bp 17",
            "lnsgkgsnl/4r4/pppp1p1Pp/4p1p1b/5R3/2P6/PP1PPPP1P/1SK6/LN1G1GSNL w Bp 18",
          ];
          for (const sfen of singleMoveCases) {
            const moves = await searchBookMoves(defaultBookSession, sfen);
            expect(moves).toHaveLength(1);
          }

          const notFoundCases = [
            "lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 2",
            "lnsgk1snl/4r1g2/pppp1p1Pp/4p1p1b/5R3/2P6/PP1PPPP1P/1SK6/LN1G1GSNL b Bp 19",
          ];
          for (const sfen of notFoundCases) {
            const moves = await searchBookMoves(defaultBookSession, sfen);
            expect(moves).toHaveLength(0);
          }
        });
      }
    });

    describe("shogihome01.sbk", () => {
      it("supports on-the-fly mode and keeps SBK move evaluation", async () => {
        const mode = await openBook(defaultBookSession, "src/tests/testdata/book/shogihome01.sbk", {
          sbkOnTheFlyThresholdMB: 0.000001,
        });
        expect(mode).toBe("on-the-fly");
        expect(getBookFormat(defaultBookSession)).toBe("sbk");

        const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
        const moves = await searchBookMoves(defaultBookSession, sfen);
        expect(moves.length).toBeGreaterThan(0);
        expect(moves.some((move) => "sbkId" in move)).toBe(false);

        const target = moves[0];
        await updateBookMove(defaultBookSession, sfen, {
          ...target,
          evaluation: SbkMoveEvaluation.Good,
          count: (target.count || 0) + 1,
        });

        const tempFilePath = path.join(tmpdir, "evaluation-test.sbk");
        await saveBook(defaultBookSession, tempFilePath);
        const saved = loadSbkBook(fs.readFileSync(tempFilePath));
        const savedMove = saved.entries.get(sfen)?.moves.find((move) => move.usi === target.usi);
        expect(savedMove?.evaluation).toBe(SbkMoveEvaluation.Good);
      });

      it("uses the SBK-specific threshold instead of the generic threshold", async () => {
        await expect(
          openBook(defaultBookSession, "src/tests/testdata/book/shogihome01.sbk", {
            onTheFlyThresholdMB: 0.000001,
            sbkOnTheFlyThresholdMB: 256,
          }),
        ).resolves.toBe("in-memory");

        clearBook(defaultBookSession);

        await expect(
          openBook(defaultBookSession, "src/tests/testdata/book/shogihome01.sbk", {
            onTheFlyThresholdMB: 256,
            sbkOnTheFlyThresholdMB: 0.000001,
          }),
        ).resolves.toBe("on-the-fly");
      });

      it("rejects SBK files above the absolute raw-data guard", async () => {
        const tempFilePath = path.join(tmpdir, "oversized.sbk");
        fs.copyFileSync("src/tests/testdata/book/shogihome01.sbk", tempFilePath);
        const file = fs.openSync(tempFilePath, "a");
        try {
          fs.ftruncateSync(file, 512 * 1024 * 1024 + 1);
        } finally {
          fs.closeSync(file);
        }
        await expect(
          openBook(defaultBookSession, tempFilePath, {
            sbkOnTheFlyThresholdMB: 0.000001,
          }),
        ).rejects.toThrow("SBK file too large");
      });
    });

    describe("yaneuraou.ybb", () => {
      const patterns = [
        { options: { onTheFlyThresholdMB: 0.01 }, mode: "in-memory" },
        { options: { onTheFlyThresholdMB: 0.0001 }, mode: "on-the-fly" },
      ];
      for (const pattern of patterns) {
        it(`mode=${pattern.mode}`, async () => {
          const mode = await openBook(
            defaultBookSession,
            "src/tests/testdata/book/yaneuraou.ybb",
            pattern.options,
          );
          expect(mode).toBe(pattern.mode);
          expect(getBookFormat(defaultBookSession)).toBe("ybb");

          const moves = await searchBookMoves(
            defaultBookSession,
            "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
          );
          expect(moves).toHaveLength(5);
          expect(moves[0].usi).toBe("2g2f");
          expect(moves[0].score).toBe(63);
          expect(moves[0].depth).toBe(27);
          expect(moves[1].usi).toBe("7g7f");
          expect(moves[1].score).toBe(20);
          expect(moves[1].depth).toBe(25);
        });
      }
    });

    it("newSession", async () => {
      const usedSessions = new Set<number>();
      for (let i = 0; i < 3; i++) {
        const { session } = await openBookAsNewSession("src/tests/testdata/book/yaneuraou.db");
        expect(session).not.toBe(defaultBookSession);
        expect(usedSessions.has(session)).toBe(false);
        usedSessions.add(session);
        const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
        await expect(searchBookMoves(session, sfen)).resolves.toHaveLength(5);
        closeBookSession(session);
        await expect(searchBookMoves(session, sfen)).rejects.toBeInstanceOf(Error);
      }
    });
  });

  it("saveBook", async () => {
    const tempFilePath = path.join(tmpdir, "savetest.db");
    await updateBookMove(
      defaultBookSession,
      "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
      {
        usi: "2g2f",
        usi2: "8c8d",
        score: 42,
        depth: 20,
        count: 123,
        comment: "ibisha\npopular",
      },
    );
    await updateBookMove(
      defaultBookSession,
      "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
      {
        usi: "7g7f",
        usi2: "3c3d",
        comment: "",
      },
    );
    await updateBookMove(
      defaultBookSession,
      "lnsgkgsnl/1r5b1/ppppppppp/9/9/2P7/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1",
      {
        usi: "3c3d",
        usi2: "6g6f",
        score: -31.5, // 小数点以下は四捨五入
        comment: "",
      },
    );
    await saveBook(defaultBookSession, tempFilePath);
    const output = fs.readFileSync(tempFilePath, "utf-8");
    expect(output).toBe(`#YANEURAOU-DB2016 1.00
sfen lnsgkgsnl/1r5b1/ppppppppp/9/9/2P7/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1
3c3d 6g6f -32 none 
sfen lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1
2g2f 8c8d 42 20 123
#ibisha
#popular
7g7f 3c3d none none 
`);
  });

  describe("updateBookMove", () => {
    it("yaneuraou", async () => {
      const sfen = "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL b - 5";
      const firstMove = {
        usi: "2f2e",
        usi2: "8d8e",
        score: 42,
        depth: 20,
        count: 123,
        comment: "yokofu",
      };
      await updateBookMove(defaultBookSession, sfen, firstMove);
      firstMove.comment = "mutated";
      await updateBookMove(defaultBookSession, sfen, {
        usi: "6i7h",
        usi2: "4a3b",
        score: -30,
        depth: 19,
        count: 21,
        comment: "",
      });
      const moves = await searchBookMoves(defaultBookSession, sfen);
      expect(moves).toHaveLength(2);
      expect(moves[0]).toEqual({
        usi: "2f2e",
        usi2: "8d8e",
        score: 42,
        depth: 20,
        count: 123,
        comment: "yokofu",
      });
      expect(moves[1]).toEqual({
        usi: "6i7h",
        usi2: "4a3b",
        score: -30,
        depth: 19,
        count: 21,
        comment: "",
      });
      moves[0].comment = "returned object mutated";
      expect((await searchBookMoves(defaultBookSession, sfen))[0].comment).toBe("yokofu");
    });

    it("apery", async () => {
      await openBook(defaultBookSession, "src/tests/testdata/book/apery.bin");
      const sfen = "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL b - 5";
      await updateBookMove(defaultBookSession, sfen, {
        usi: "2f2e",
        score: 42,
        depth: 20,
        count: 123,
        comment: "",
      });
      await updateBookMove(defaultBookSession, sfen, {
        usi: "6i7h",
        score: -30,
        count: 21,
        comment: "",
      });
      const moves = await searchBookMoves(defaultBookSession, sfen);
      expect(moves).toHaveLength(2);
      expect(moves[0]).toEqual({
        usi: "2f2e",
        score: 42,
        count: 123,
        comment: "",
      });
      expect(moves[1]).toEqual({
        usi: "6i7h",
        score: -30,
        count: 21,
        comment: "",
      });
    });

    it("ybb", async () => {
      await openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou.ybb");
      const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
      await updateBookMove(defaultBookSession, sfen, {
        usi: "2g2f",
        score: 100,
        depth: 30,
        count: 999,
        comment: "",
      });
      const moves = await searchBookMoves(defaultBookSession, sfen);
      expect(moves).toHaveLength(5);
      expect(moves[0].usi).toBe("2g2f");
      expect(moves[0].score).toBe(100);
      expect(moves[0].depth).toBe(30);
      expect(moves[0].count).toBe(999);
    });
  });

  describe("copy", () => {
    it("yaneuraou", async () => {
      const copyFilePath = path.join(tmpdir, "copy.db");
      await openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou.db");
      await saveBook(defaultBookSession, copyFilePath);
      const output = fs.readFileSync(copyFilePath, "utf-8");
      const expected = fs.readFileSync("src/tests/testdata/book/yaneuraou-copy.db", "utf-8");
      expect(output).toBe(expected);
    });

    it("apery", async () => {
      const copyFilePath = path.join(tmpdir, "copy.bin");
      await openBook(defaultBookSession, "src/tests/testdata/book/apery.bin");
      await saveBook(defaultBookSession, copyFilePath);
      const output = fs.readFileSync(copyFilePath, "hex");
      const expected = fs.readFileSync("src/tests/testdata/book/apery.bin", "hex");
      expect(output).toBe(expected);
    });

    it("ybb", async () => {
      const copyFilePath = path.join(tmpdir, "copy.ybb");
      await openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou.ybb");
      await saveBook(defaultBookSession, copyFilePath);
      const output = fs.readFileSync(copyFilePath, "hex");
      const expected = fs.readFileSync("src/tests/testdata/book/yaneuraou.ybb", "hex");
      expect(output).toBe(expected);
    });

    it("apery large", async () => {
      // チャンクの境界処理をテストするために大きなファイルを作成
      const sourcePath = path.join(tmpdir, "source.bin");
      await createTestAperyBookFile(sourcePath, 1_000_000); // 1MB
      await openBook(defaultBookSession, sourcePath);
      const copyFilePath = path.join(tmpdir, "copy-large.bin");
      await saveBook(defaultBookSession, copyFilePath);
      const output = await sha256File(copyFilePath);
      const expected = await sha256File(sourcePath);
      expect(output).toBe(expected);
    });
  });

  it("updateBookMoveOrder", async () => {
    await openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou.db");
    const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

    await updateBookMoveOrder(defaultBookSession, sfen, "2g2f", 2);
    await updateBookMoveOrder(defaultBookSession, sfen, "3g3f", 0);

    const moves = await searchBookMoves(defaultBookSession, sfen);
    expect(moves).toHaveLength(5);
    expect(moves[0].usi).toBe("3g3f");
    expect(moves[1].usi).toBe("7g7f");
    expect(moves[2].usi).toBe("5g5f");
    expect(moves[3].usi).toBe("2g2f");
    expect(moves[4].usi).toBe("2h7h");
  });

  it("removeBookMove", async () => {
    await openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou.db");
    const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

    await removeBookMove(defaultBookSession, sfen, "2g2f");
    await removeBookMove(defaultBookSession, sfen, "2h7h");

    const moves = await searchBookMoves(
      defaultBookSession,
      "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    );
    expect(moves).toHaveLength(3);
    expect(moves[0].usi).toBe("7g7f");
    expect(moves[1].usi).toBe("5g5f");
    expect(moves[2].usi).toBe("3g3f");
  });

  describe("importBookMoves", async () => {
    const patterns = [
      {
        title: "directory",
        settings: {
          sourceType: SourceType.DIRECTORY,
          sourceDirectory: "src/tests/testdata/book/source",
        },
        summary: {
          successFileCount: 5,
          errorFileCount: 0,
          skippedFileCount: 0,
          entryCount: 43,
          duplicateCount: 4,
        },
        includedSFEN: [
          "ln1gk1snl/1rs3gb1/p1ppppppp/9/1p5P1/P8/1PPPPPP1P/1BG3SR1/LNS1KG1NL w - 1",
          "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P1P4/PP1P1PPPP/1B2R4/LNSGKGSNL w - 1",
        ],
        missedSFEN: ["ln1gk1snl/1rs3gb1/2ppppppp/p8/1p5P1/P8/1PPPPPP1P/1BG3SR1/LNS1KG1NL b - 1"],
      },
      {
        title: "directory with ply",
        settings: {
          sourceType: SourceType.DIRECTORY,
          sourceDirectory: "src/tests/testdata/book/source",
          minPly: 2,
          maxPly: 5,
        },
        summary: {
          successFileCount: 5,
          errorFileCount: 0,
          skippedFileCount: 0,
          entryCount: 23,
          duplicateCount: 1,
        },
        includedSFEN: ["lnsgkgsnl/1r5b1/p1ppppppp/9/1p5P1/9/PPPPPPP1P/1B5R1/LNSGKGSNL b - 1"],
        missedSFEN: [
          "lnsgkgsnl/1r5b1/p1ppppppp/9/1p5P1/9/PPPPPPP1P/1BG4R1/LNS1KGSNL w - 1",
          "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P1P4/PP1P1PPPP/1B2R4/LNSGKGSNL w - 1",
        ],
      },
      {
        title: "directory with player name",
        settings: {
          sourceType: SourceType.DIRECTORY,
          sourceDirectory: "src/tests/testdata/book/source",
          playerCriteria: PlayerCriteria.FILTER_BY_NAME,
          playerName: "藤井",
        },
        summary: {
          successFileCount: 4,
          errorFileCount: 0,
          skippedFileCount: 1, // .sfen file is skipped
          entryCount: 10,
          duplicateCount: 0,
        },
        includedSFEN: ["lnsgkgsnl/1r5b1/p1ppppppp/9/1p5P1/9/PPPPPPP1P/1BG4R1/LNS1KGSNL w - 1"],
        missedSFEN: [
          "lnsgkgsnl/1r5b1/p1ppppppp/9/1p5P1/9/PPPPPPP1P/1B5R1/LNSGKGSNL b - 1",
          "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P1P4/PP1P1PPPP/1B2R4/LNSGKGSNL w - 1",
        ],
      },
      {
        title: "single file",
        settings: {
          sourceType: SourceType.FILE,
          sourceRecordFile: "src/tests/testdata/book/source/src01.ki2",
        },
        summary: {
          successFileCount: 1,
          errorFileCount: 0,
          skippedFileCount: 0,
          entryCount: 10,
          duplicateCount: 0,
        },
        includedSFEN: ["lnsgkgsnl/1r5b1/p1pppp1pp/6p2/1p7/2P4P1/PPBPPPP1P/7R1/LNSGKGSNL b - 1"],
        missedSFEN: ["lnsgk1snl/1r4gb1/p1ppppppp/9/1p5P1/9/PPPPPPP1P/1BG4R1/LNS1KGSNL b - 1"],
      },
      {
        title: "single file black",
        settings: {
          sourceType: SourceType.FILE,
          sourceRecordFile: "src/tests/testdata/book/source/src01.ki2",
          playerCriteria: PlayerCriteria.BLACK,
        },
        summary: {
          successFileCount: 1,
          errorFileCount: 0,
          skippedFileCount: 0,
          entryCount: 5,
          duplicateCount: 0,
        },
        includedSFEN: ["lnsgkgsnl/1r5b1/p1pppp1pp/6p2/1p7/2P4P1/PPBPPPP1P/7R1/LNSGKGSNL b - 1"],
        missedSFEN: ["lnsgkgsnl/1r5b1/p1pppp1pp/6p2/1p7/2P4P1/PPBPPPP1P/1S5R1/LN1GKGSNL w - 1"],
      },
      {
        title: "single file white",
        settings: {
          sourceType: SourceType.FILE,
          sourceRecordFile: "src/tests/testdata/book/source/src01.ki2",
          playerCriteria: PlayerCriteria.WHITE,
        },
        summary: {
          successFileCount: 1,
          errorFileCount: 0,
          skippedFileCount: 0,
          entryCount: 5,
          duplicateCount: 0,
        },
        includedSFEN: ["lnsgkgsnl/1r5b1/p1pppp1pp/6p2/1p7/2P4P1/PPBPPPP1P/1S5R1/LN1GKGSNL w - 1"],
        missedSFEN: ["lnsgkgsnl/1r5b1/p1pppp1pp/6p2/1p7/2P4P1/PPBPPPP1P/7R1/LNSGKGSNL b - 1"],
      },
    ];
    for (const pattern of patterns) {
      it(pattern.title, async () => {
        const summary = await importBookMoves(
          defaultBookSession,
          {
            ...defaultBookImportSettings(),
            ...pattern.settings,
          },
          undefined,
          process.cwd(),
        );
        expect(summary).toEqual(pattern.summary);
        for (const sfen of pattern.includedSFEN) {
          expect((await searchBookMoves(defaultBookSession, sfen)).length).not.toBe(0);
        }
        for (const sfen of pattern.missedSFEN) {
          expect((await searchBookMoves(defaultBookSession, sfen)).length).toBe(0);
        }
      });
    }

    it("rejects a file outside the import root", async () => {
      const root = path.join(tmpdir, "import-root");
      const outsideFile = path.join(tmpdir, "outside.ki2");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(outsideFile, "dummy");

      await expect(
        importBookMoves(
          defaultBookSession,
          {
            ...defaultBookImportSettings(),
            sourceType: SourceType.FILE,
            sourceRecordFile: outsideFile,
          },
          undefined,
          root,
        ),
      ).rejects.toThrow("Forbidden path");
    });

    it("rejects a symlinked file outside the import root", async () => {
      const root = path.join(tmpdir, "import-root-symlink");
      const outsideFile = path.join(tmpdir, "outside-symlink.ki2");
      const linkFile = path.join(root, "link.ki2");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(outsideFile, "dummy");
      try {
        fs.symlinkSync(outsideFile, linkFile);
      } catch {
        return;
      }

      await expect(
        importBookMoves(
          defaultBookSession,
          {
            ...defaultBookImportSettings(),
            sourceType: SourceType.FILE,
            sourceRecordFile: linkFile,
          },
          undefined,
          root,
        ),
      ).rejects.toThrow("Forbidden path");
    });

    it("importBookMoves - with score and depth", async () => {
      await importBookMoves(
        defaultBookSession,
        {
          ...defaultBookImportSettings(),
          sourceType: SourceType.DIRECTORY,
          sourceDirectory: "src/tests/testdata/book/source-with-score",
        },
        undefined,
        process.cwd(),
      );
      expect(
        await searchBookMoves(
          defaultBookSession,
          "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P6/PP1PPPPPP/1B1R5/LNSGKGSNL b - 1",
        ),
      ).toEqual([{ usi: "6g6f", count: 3, depth: 31, score: -72, comment: "" }]);
      expect(
        await searchBookMoves(
          defaultBookSession,
          "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2PP5/PP2PPPPP/1B1R5/LNSGKGSNL w - 1",
        ),
      ).toEqual([{ usi: "8d8e", count: 3, depth: 21, score: 97, comment: "" }]);
      expect(
        await searchBookMoves(
          defaultBookSession,
          "ln1gkgsnl/1r1s3b1/p1pppp1pp/6p2/1p7/2PP5/PPB1PPPPP/3R5/LNSGKGSNL b - 1",
        ),
      ).toEqual([{ usi: "1g1f", count: 3, score: 30000, comment: "" }]);
      expect(
        await searchBookMoves(
          defaultBookSession,
          "ln1gkgsnl/1r1s3b1/p1pppp1pp/6p2/1p7/2PP4P/PPB1PPPP1/3R5/LNSGKGSNL w - 1",
        ),
      ).toEqual([{ usi: "5a4b", count: 3, score: 30000, comment: "" }]);
    });

    it("importBookMoves - importScore: false", async () => {
      await importBookMoves(
        defaultBookSession,
        {
          ...defaultBookImportSettings(),
          sourceType: SourceType.DIRECTORY,
          sourceDirectory: "src/tests/testdata/book/source-with-score",
          importScore: false,
        },
        undefined,
        process.cwd(),
      );
      expect(
        await searchBookMoves(
          defaultBookSession,
          "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P6/PP1PPPPPP/1B1R5/LNSGKGSNL b - 1",
        ),
      ).toEqual([{ usi: "6g6f", count: 3, comment: "" }]);
    });
  });

  describe("merge", () => {
    it("yaneuraou", async () => {
      const mode = await openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou.db", {
        onTheFlyThresholdMB: 0.0001,
      });
      expect(mode).toBe("on-the-fly");

      // 先頭へ追加
      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL b - 1",
        {
          usi: "2f2e",
          score: 20,
          depth: 19,
          count: 89,
          comment: "patch-1",
        },
      );
      // 途中へ追加
      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2PP5/PP2PPPPP/1B5R1/LNSGKGSNL w - 1",
        {
          usi: "8b3b",
          score: 10,
          depth: 23,
          count: 8,
          comment: "patch-2",
        },
      );
      // 末尾へ追加
      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/6rb1/pppppp1pp/6p2/9/2PP5/PP2PPPPP/1BS4R1/LN1GKGSNL w - 1",
        {
          usi: "3d3f",
          score: 15,
          depth: 21,
          count: 7,
          comment: "patch-3",
        },
      );
      // 既存の指し手を更新
      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/3P5/PPP1PPPPP/1BS4R1/LN1GKGSNL w - 1",
        {
          usi: "8b3b",
          count: 2,
          comment: "patch-4",
        },
      );
      // 既存の指し手の順序を更新
      await updateBookMoveOrder(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/3P5/PPP1PPPPP/1BS4R1/LN1GKGSNL w - 1",
        "3a4b",
        1,
      );
      // 指し手を削除
      await removeBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1",
        "3c3d",
      );

      const mergeFilePath = path.join(tmpdir, "mverge.db");
      await saveBook(defaultBookSession, mergeFilePath);
      const output = fs.readFileSync(mergeFilePath, "utf-8");
      const expected = fs.readFileSync("src/tests/testdata/book/yaneuraou-merge.db", "utf-8");
      expect(output).toBe(expected);

      // 2回目の書き込みを検査する
      const mergeFilePath2 = path.join(tmpdir, "mverge2.db");
      await saveBook(defaultBookSession, mergeFilePath2);
      const output2 = fs.readFileSync(mergeFilePath2, "utf-8");
      expect(output2).toBe(expected);
    });

    it("apery", async () => {
      const mode = await openBook(defaultBookSession, "src/tests/testdata/book/apery.bin", {
        onTheFlyThresholdMB: 0.0001,
      });
      expect(mode).toBe("on-the-fly");

      // 指し手を追加
      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/pppppp1pp/9/6pP1/2P6/PP1PPPP1P/1B5R1/LNSGKGSNL w - 1",
        {
          usi: "8b3b",
          score: -10,
          count: 7,
          comment: "",
        },
      );
      // 末尾に指し手を追加
      await updateBookMove(
        defaultBookSession,
        "+B2g3nl/l1s2kgs1/p1nppp2p/2p3p2/2r6/P8/1PPPPPP1P/2GK2SR1/LNS2G1NL w b3p 1",
        { usi: "B*8c", score: 0, count: 1, comment: "" },
      );
      // 既存の指し手を更新
      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL w - 1",
        { usi: "2c2d", score: -120, count: 10, comment: "" },
      );
      // 既存の指し手の順序を更新
      await updateBookMoveOrder(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL w - 1",
        "3d3e",
        0,
      );
      // 指し手を削除
      await removeBookMove(
        defaultBookSession,
        "lnsgkgsnl/4r4/pppp1p1Pp/4p1p1b/5R3/2P6/PP1PPPP1P/1SK6/LN1G1GSNL w Bp 1",
        "4a3b",
      );

      const mergeFilePath = path.join(tmpdir, "merge.bin");
      await saveBook(defaultBookSession, mergeFilePath);
      const output = fs.readFileSync(mergeFilePath, "hex");
      const expected = fs.readFileSync("src/tests/testdata/book/apery-merge.bin", "hex");
      expect(output).toBe(expected);

      // 2回目の書き込みを検査する
      const mergeFilePath2 = path.join(tmpdir, "merge2.bin");
      await saveBook(defaultBookSession, mergeFilePath2);
      const output2 = fs.readFileSync(mergeFilePath2, "hex");
      expect(output2).toBe(expected);
    });

    it("ybb", async () => {
      const mode = await openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou.ybb", {
        onTheFlyThresholdMB: 0.0001,
      });
      expect(mode).toBe("on-the-fly");

      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/ppppppppp/9/9/7P1/PPPPPPP1P/1B5R1/LNSGKGSNL w - 1",
        { usi: "3c3d", score: -123, depth: 41, comment: "" },
      );
      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/7P1/PPPPPPP1P/1B5R1/LNSGKGSNL b - 1",
        { usi: "7g7f", depth: 39, comment: "" },
      );
      await updateBookMove(
        defaultBookSession,
        "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
        { usi: "2h7h", score: 43, comment: "" },
      );

      const mergeFilePath = path.join(tmpdir, "merge.ybb");
      await saveBook(defaultBookSession, mergeFilePath);
      const output = fs.readFileSync(mergeFilePath, "hex");
      const expected = fs.readFileSync("src/tests/testdata/book/yaneuraou-edit.ybb", "hex");
      expect(output).toBe(expected);
    });

    describe("overwriteOnTheFly", () => {
      const startSfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

      async function openOnTheFly(source: string, filePath: string): Promise<void> {
        fs.copyFileSync(source, filePath);
        const mode = await openBook(defaultBookSession, filePath, {
          onTheFlyThresholdMB: 0.0001,
          sbkOnTheFlyThresholdMB: 0.000001,
        });
        expect(mode).toBe("on-the-fly");
      }

      async function searchInFreshSession(filePath: string, sfen: string) {
        const { session } = await openBookAsNewSession(filePath, {
          onTheFlyThresholdMB: 256,
          sbkOnTheFlyThresholdMB: 256,
        });
        try {
          return await searchBookMoves(session, sfen);
        } finally {
          closeBookSession(session);
        }
      }

      it("yaneuraou", async () => {
        const filePath = path.join(tmpdir, "overwrite.db");
        await openOnTheFly("src/tests/testdata/book/yaneuraou.db", filePath);

        await updateBookMove(defaultBookSession, startSfen, {
          usi: "2g2f",
          usi2: "8c8d",
          score: 42,
          depth: 20,
          count: 123,
          comment: "overwrite",
        });
        await saveBook(defaultBookSession, filePath);

        // The session reflects exactly the published content: the file handle
        // was switched to the new file and the patches were consumed.
        const moves = await searchBookMoves(defaultBookSession, startSfen);
        expect(moves[0]).toMatchObject({
          usi: "2g2f",
          usi2: "8c8d",
          score: 42,
          depth: 20,
          count: 123,
        });
        const fresh = await searchInFreshSession(filePath, startSfen);
        expect(fresh[0]).toMatchObject({
          usi: "2g2f",
          usi2: "8c8d",
          score: 42,
          depth: 20,
          count: 123,
          comment: "overwrite",
        });
        expect(moves).toEqual(fresh);

        // Saving again without edits must not change the file (no
        // double-application of consumed patches).
        const hash = await sha256File(filePath);
        await saveBook(defaultBookSession, filePath);
        expect(await sha256File(filePath)).toBe(hash);
      });

      it("preserves move comments after overwriting, reordering, and overwriting again", async () => {
        const filePath = path.join(tmpdir, "overwrite-comments.db");
        await openOnTheFly("src/tests/testdata/book/yaneuraou.db", filePath);
        await updateBookMove(defaultBookSession, startSfen, {
          usi: "2g2f",
          comment: "first line\nsecond line",
        });
        await saveBook(defaultBookSession, filePath);

        await updateBookMoveOrder(defaultBookSession, startSfen, "2g2f", 1);
        await saveBook(defaultBookSession, filePath);

        const fresh = await searchInFreshSession(filePath, startSfen);
        expect(fresh[0]).toMatchObject({ usi: "7g7f", comment: "single line comment" });
        expect(fresh[1]).toMatchObject({ usi: "2g2f", comment: "first line\nsecond line" });
        expect(await searchBookMoves(defaultBookSession, startSfen)).toEqual(fresh);
      });

      it("apery", async () => {
        const filePath = path.join(tmpdir, "overwrite.bin");
        await openOnTheFly("src/tests/testdata/book/apery.bin", filePath);
        const sfen = "lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL b - 5";

        await updateBookMove(defaultBookSession, sfen, {
          usi: "2f2e",
          score: 42,
          count: 123,
          comment: "",
        });
        await saveBook(defaultBookSession, filePath);

        const moves = await searchBookMoves(defaultBookSession, sfen);
        expect(moves).toHaveLength(1);
        expect(moves[0].usi).toBe("2f2e");
        expect(moves[0].score).toBe(42);
        expect(moves).toEqual(await searchInFreshSession(filePath, sfen));

        const hash = await sha256File(filePath);
        await saveBook(defaultBookSession, filePath);
        expect(await sha256File(filePath)).toBe(hash);
      });

      it("ybb", async () => {
        const filePath = path.join(tmpdir, "overwrite.ybb");
        await openOnTheFly("src/tests/testdata/book/yaneuraou.ybb", filePath);

        await updateBookMove(
          defaultBookSession,
          "lnsgkgsnl/1r5b1/ppppppppp/9/9/7P1/PPPPPPP1P/1B5R1/LNSGKGSNL w - 1",
          { usi: "3c3d", score: -123, depth: 41, comment: "" },
        );
        await updateBookMove(
          defaultBookSession,
          "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/7P1/PPPPPPP1P/1B5R1/LNSGKGSNL b - 1",
          { usi: "7g7f", depth: 39, comment: "" },
        );
        await updateBookMove(defaultBookSession, startSfen, {
          usi: "2h7h",
          score: 43,
          comment: "",
        });
        await saveBook(defaultBookSession, filePath);

        const output = fs.readFileSync(filePath, "hex");
        const expected = fs.readFileSync("src/tests/testdata/book/yaneuraou-edit.ybb", "hex");
        expect(output).toBe(expected);
        const moves = await searchBookMoves(defaultBookSession, startSfen);
        expect(moves).toEqual(await searchInFreshSession(filePath, startSfen));

        const hash = await sha256File(filePath);
        await saveBook(defaultBookSession, filePath);
        expect(await sha256File(filePath)).toBe(hash);
      });

      it("sbk", async () => {
        const filePath = path.join(tmpdir, "overwrite.sbk");
        await openOnTheFly("src/tests/testdata/book/shogihome01.sbk", filePath);
        const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

        const target = (await searchBookMoves(defaultBookSession, sfen))[0];
        await updateBookMove(defaultBookSession, sfen, {
          ...target,
          evaluation: SbkMoveEvaluation.Good,
        });
        await saveBook(defaultBookSession, filePath);

        const saved = loadSbkBook(fs.readFileSync(filePath));
        const savedMove = saved.entries.get(sfen)?.moves.find((move) => move.usi === target.usi);
        expect(savedMove?.evaluation).toBe(SbkMoveEvaluation.Good);
        const moves = await searchBookMoves(defaultBookSession, sfen);
        expect(moves).toEqual(await searchInFreshSession(filePath, sfen));

        const hash = await sha256File(filePath);
        await saveBook(defaultBookSession, filePath);
        expect(await sha256File(filePath)).toBe(hash);
      });

      it("keeps the original file and the unsaved edits when the rename fails", async () => {
        const filePath = path.join(tmpdir, "overwrite-rename-failure.db");
        await openOnTheFly("src/tests/testdata/book/yaneuraou.db", filePath);
        await updateBookMove(defaultBookSession, startSfen, {
          usi: "2g2f",
          usi2: "8c8d",
          score: 42,
          comment: "unsaved",
        });
        const originalHash = await sha256File(filePath);

        const renameSpy = vi
          .spyOn(fs.promises, "rename")
          .mockRejectedValueOnce(new Error("rename failed"));
        await expect(saveBook(defaultBookSession, filePath)).rejects.toThrow("rename failed");
        renameSpy.mockRestore();

        // The original file and the unsaved edits are kept.
        expect(await sha256File(filePath)).toBe(originalHash);
        const moves = await searchBookMoves(defaultBookSession, startSfen);
        expect(moves[0].usi2).toBe("8c8d");
        expect(moves[0].comment).toBe("unsaved");

        // The session is still usable and the next save succeeds.
        await saveBook(defaultBookSession, filePath);
        const savedMoves = await searchBookMoves(defaultBookSession, startSfen);
        const savedFresh = await searchInFreshSession(filePath, startSfen);
        expect(savedFresh[0]).toMatchObject({
          usi: "2g2f",
          usi2: "8c8d",
          score: 42,
          comment: "unsaved",
        });
        expect(savedMoves).toEqual(savedFresh);
        expect(fs.readdirSync(tmpdir).filter((name) => name.startsWith(".atomic-"))).toEqual([]);
      });

      it("rejects normalized duplicate positions before publishing an overwrite", async () => {
        const filePath = path.join(tmpdir, "overwrite-normalized-duplicates.db");
        const original = [
          "#YANEURAOU-DB2016 1.00",
          `sfen ${startSfen}`,
          "7g7f none 10 20 1",
          `sfen ${startSfen.replace(/ 1$/, " 5")}`,
          "2g2f none 30 20 1",
          "",
        ].join("\n");
        fs.writeFileSync(filePath, original);
        expect(await openBook(defaultBookSession, filePath, { onTheFlyThresholdMB: 0 })).toBe(
          "on-the-fly",
        );
        // Leave the duplicate group untouched while editing another position.
        const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1";
        const move = { usi: "3c3d", score: 42, comment: "unsaved" };
        await updateBookMove(defaultBookSession, sfen, move);

        await expect(saveBook(defaultBookSession, filePath)).rejects.toThrow(
          "Book is not ordered by position",
        );
        expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
        expect(await searchBookMoves(defaultBookSession, sfen)).toEqual([move]);
        expect(fs.readdirSync(tmpdir).filter((name) => name.startsWith(".atomic-"))).toEqual([]);
        const fresh = await openBookAsNewSession(filePath, { onTheFlyThresholdMB: 0 });
        closeBookSession(fresh.session);
        expect(fresh.mode).toBe("on-the-fly");
      });

      it("keeps the original file and the unsaved edits when preparing the new book fails", async () => {
        const filePath = path.join(tmpdir, "overwrite-prepare-failure.db");
        await openOnTheFly("src/tests/testdata/book/yaneuraou.db", filePath);
        await updateBookMove(defaultBookSession, startSfen, {
          usi: "2g2f",
          usi2: "8c8d",
          score: 42,
          comment: "unsaved",
        });
        const originalHash = await sha256File(filePath);

        // Reject opening the temporary file for reading during the prepare
        // phase (mode "r" on an atomic temporary file).
        const originalOpen = fs.promises.open.bind(fs.promises);
        const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(((
          path: fs.PathLike,
          flags: string,
          mode?: number,
        ) => {
          if (
            flags === "r" &&
            typeof path === "string" &&
            path.includes(".atomic-") &&
            path.endsWith(".tmp")
          ) {
            return Promise.reject(new Error("open failed"));
          }
          return originalOpen(path, flags, mode) as ReturnType<typeof fs.promises.open>;
        }) as typeof fs.promises.open);
        await expect(saveBook(defaultBookSession, filePath)).rejects.toThrow("open failed");
        openSpy.mockRestore();

        expect(await sha256File(filePath)).toBe(originalHash);
        const moves = await searchBookMoves(defaultBookSession, startSfen);
        expect(moves[0].comment).toBe("unsaved");

        await saveBook(defaultBookSession, filePath);
        const savedMoves = await searchBookMoves(defaultBookSession, startSfen);
        const savedFresh = await searchInFreshSession(filePath, startSfen);
        expect(savedFresh[0]).toMatchObject({
          usi: "2g2f",
          usi2: "8c8d",
          score: 42,
          comment: "unsaved",
        });
        expect(savedMoves).toEqual(savedFresh);
        expect(fs.readdirSync(tmpdir).filter((name) => name.startsWith(".atomic-"))).toEqual([]);
      });
    });
  });

  describe("concurrency", () => {
    it("should prevent concurrent save and update", async () => {
      const tempFilePath = path.join(tmpdir, "concurrency.db");
      await openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou.db");

      // Start saving (async)
      const savePromise = saveBook(defaultBookSession, tempFilePath);

      try {
        // Try to update move while saving
        const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
        await expect(
          updateBookMove(defaultBookSession, sfen, { usi: "2g2f", comment: "test" }),
        ).rejects.toThrow();

        // Try to save again
        await expect(saveBook(defaultBookSession, tempFilePath)).rejects.toThrow();
      } finally {
        await savePromise;
      }

      // Should be able to update after save
      const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
      await expect(
        updateBookMove(defaultBookSession, sfen, { usi: "2g2f", comment: "test" }),
      ).resolves.toBeUndefined();
    });

    it("should prevent concurrent import", async () => {
      await openBook(defaultBookSession, "src/tests/testdata/book/yaneuraou.db");

      // Start importing (async)
      const importPromise = importBookMoves(
        defaultBookSession,
        {
          ...defaultBookImportSettings(),
          sourceType: SourceType.DIRECTORY,
          sourceDirectory: "src/tests/testdata/book/source",
        },
        undefined,
        process.cwd(),
      );

      try {
        // Try to save while importing
        const tempFilePath = path.join(tmpdir, "concurrency-import.db");
        await expect(saveBook(defaultBookSession, tempFilePath)).rejects.toThrow();
      } finally {
        await importPromise;
      }

      // Should be able to save after import
      const tempFilePath = path.join(tmpdir, "concurrency-import.db");
      await expect(saveBook(defaultBookSession, tempFilePath)).resolves.toBeUndefined();
    });
  });
});
