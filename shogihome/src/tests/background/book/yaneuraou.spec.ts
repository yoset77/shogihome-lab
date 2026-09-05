import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  loadYaneuraOuBook,
  searchYaneuraOuBookMovesOnTheFly,
  validateBookPositionOrdering,
} from "@/server/book/yaneuraou";
import { getTempPathForTesting } from "@/tests/helpers/temp";

describe("background/book/yaneuraou", () => {
  it.each(["\n", "\r\n"])(
    "preserves position and move comments on-the-fly with %j",
    async (eol) => {
      const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
      const text = [
        "#YANEURAOU-DB2016 1.00",
        `sfen ${sfen}`,
        "#position comment",
        "//\u5c40\u9762",
        "2g2f none 42 20 1 #inline",
        "#\u6307\u3057\u624b",
        "//second line",
        "7g7f none 20 18 2",
        "#another move",
        "sfen lnsgkgsnl/1r7/p1ppp1bpp/1p3pp2/7P1/2P6/PP1PPPP1P/1B3S1R1/LNSGKG1NL b - 1",
        "7i6h none 0 10 1",
        "",
      ].join(eol);
      const directory = getTempPathForTesting();
      fs.mkdirSync(directory, { recursive: true });
      const filePath = path.join(directory, `comments-${eol.length}.db`);
      fs.writeFileSync(filePath, text);
      const file = await fs.promises.open(filePath, "r");
      try {
        const expected = (await loadYaneuraOuBook(Readable.from([text]))).entries.get(sfen);
        expect(expected).toMatchObject({
          comment: "position comment\n\u5c40\u9762",
          moves: [
            { usi: "2g2f", comment: "inline\n\u6307\u3057\u624b\nsecond line" },
            { usi: "7g7f", comment: "another move" },
          ],
        });
        expect(await searchYaneuraOuBookMovesOnTheFly(sfen, file, Buffer.byteLength(text))).toEqual(
          expected,
        );
      } finally {
        await file.close();
      }
    },
  );

  describe("loadYaneuraOuBook", () => {
    it("ok", async () => {
      const input = Readable.from([
        "#YANEURAOU-DB2016 1.00\n",
        "sfen +P1kg3nl/1ps2b3/+P3p3p/2pgsr1p1/s2p1pP2/2P1P1pR1/1SNG1P2P/1KG6/7NL w N2LPb2p 78\n",
        "4e4f 9c9d 120 40 2\n",
        "6e6f 6g6h -32 32 0\n",
        "sfen lnB4nl/4k1g2/p3pps2/1G5rp/1pPPsb3/3p2P1P/PPS1PP3/2G1KSGP1/LN5NL w R2Pp 64\n",
        "4e7h+ none 540 38 1\n",
        "2d8d none 140 36 1\n",
        "sfen +B3g3l/5rgk1/pB+P1ppn1p/n4spp1/1G1SP3P/K2P5/1+pS3P2/P2+l+r4/LNP6 b SNL2Pg2p\n",
        "9f9e 8g7g 0 32 1\n",
      ]);
      const book = await loadYaneuraOuBook(input);
      expect(book.entries.size).toBe(3);
      expect(Object.fromEntries(book.entries)).toEqual({
        "+P1kg3nl/1ps2b3/+P3p3p/2pgsr1p1/s2p1pP2/2P1P1pR1/1SNG1P2P/1KG6/7NL w N2LPb2p 1": {
          type: "normal",
          comment: "",
          moves: [
            { usi: "4e4f", usi2: "9c9d", score: 120, depth: 40, count: 2, comment: "" },
            { usi: "6e6f", usi2: "6g6h", score: -32, depth: 32, count: 0, comment: "" },
          ],
          minPly: 78,
        },
        "lnB4nl/4k1g2/p3pps2/1G5rp/1pPPsb3/3p2P1P/PPS1PP3/2G1KSGP1/LN5NL w R2Pp 1": {
          type: "normal",
          comment: "",
          moves: [
            { usi: "4e7h+", usi2: undefined, score: 540, depth: 38, count: 1, comment: "" },
            { usi: "2d8d", usi2: undefined, score: 140, depth: 36, count: 1, comment: "" },
          ],
          minPly: 64,
        },
        "+B3g3l/5rgk1/pB+P1ppn1p/n4spp1/1G1SP3P/K2P5/1+pS3P2/P2+l+r4/LNP6 b SNL2Pg2p 1": {
          type: "normal",
          comment: "",
          moves: [{ usi: "9f9e", usi2: "8g7g", score: 0, depth: 32, count: 1, comment: "" }],
          minPly: 0,
        },
      });
    });

    it("invalid header", async () => {
      const input = Readable.from([
        "#YANEURAOU-DB2016 2.00\n",
        "sfen +P1kg3nl/1ps2b3/+P3p3p/2pgsr1p1/s2p1pP2/2P1P1pR1/1SNG1P2P/1KG6/7NL w N2LPb2p 78\n",
        "4e4f 9c9d 120 40 2\n",
        "6e6f 6g6h -32 32 0\n",
        "sfen lnB4nl/4k1g2/p3pps2/1G5rp/1pPPsb3/3p2P1P/PPS1PP3/2G1KSGP1/LN5NL w R2Pp 64\n",
        "4e7h+ none 540 38 1\n",
        "2d8d none 140 36 1\n",
        "sfen +B3g3l/5rgk1/pB+P1ppn1p/n4spp1/1G1SP3P/K2P5/1+pS3P2/P2+l+r4/LNP6 b SNL2Pg2p\n",
        "9f9e 8g7g 0 32 1\n",
      ]);
      await expect(loadYaneuraOuBook(input)).rejects.toThrow(
        "Unsupported book header: #YANEURAOU-DB2016 2.00",
      );
    });
  });

  describe("validateBookPositionOrdering", async () => {
    it("ordered", async () => {
      const input = Readable.from([
        "#YANEURAOU-DB2016 1.00\n",
        "sfen +B3g3l/5rgk1/pB+P1ppn1p/n4spp1/1G1SP3P/K2P5/1+pS3P2/P2+l+r4/LNP6 b SNL2Pg2p\n",
        "9f9e 8g7g 0 32 1\n",
        "sfen +P1kg3nl/1ps2b3/+P3p3p/2pgsr1p1/s2p1pP2/2P1P1pR1/1SNG1P2P/1KG6/7NL w N2LPb2p 78\n",
        "4e4f 9c9d 120 40 2\n",
        "6e6f 6g6h -32 32 0\n",
        "sfen lnB4nl/4k1g2/p3pps2/1G5rp/1pPPsb3/3p2P1P/PPS1PP3/2G1KSGP1/LN5NL w R2Pp 64\n",
        "4e7h+ none 540 38 1\n",
        "2d8d none 140 36 1\n",
      ]);
      expect(await validateBookPositionOrdering(input)).toBeTruthy();
    });

    it("not ordered", async () => {
      const input = Readable.from([
        "#YANEURAOU-DB2016 1.00\n",
        "sfen +P1kg3nl/1ps2b3/+P3p3p/2pgsr1p1/s2p1pP2/2P1P1pR1/1SNG1P2P/1KG6/7NL w N2LPb2p 78\n",
        "4e4f 9c9d 120 40 2\n",
        "6e6f 6g6h -32 32 0\n",
        "sfen lnB4nl/4k1g2/p3pps2/1G5rp/1pPPsb3/3p2P1P/PPS1PP3/2G1KSGP1/LN5NL w R2Pp 64\n",
        "4e7h+ none 540 38 1\n",
        "2d8d none 140 36 1\n",
        "sfen +B3g3l/5rgk1/pB+P1ppn1p/n4spp1/1G1SP3P/K2P5/1+pS3P2/P2+l+r4/LNP6 b SNL2Pg2p\n",
        "9f9e 8g7g 0 32 1\n",
      ]);
      expect(await validateBookPositionOrdering(input)).toBeFalsy();
    });
  });
});
