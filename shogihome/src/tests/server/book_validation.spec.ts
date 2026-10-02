import { parseBookSfen } from "@/server/book/validation";
import * as aperyZobrist from "@/server/book/apery_zobrist";

const startpos = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
const afterMoves = "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b - 1";

describe("book SFEN validation", () => {
  it("normalizes book positions without computing an Apery hash", () => {
    const hash = vi.spyOn(aperyZobrist, "hash");
    try {
      expect(parseBookSfen(startpos)).toBe(startpos);
      expect(hash).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }
  });

  it.each([
    [startpos.replace(/ 1$/, " 42"), startpos],
    ["startpos", startpos],
    ["position startpos", startpos],
    [`sfen ${startpos}`, startpos],
    [`position sfen ${startpos}`, startpos],
    ["startpos moves 7g7f 3c3d", afterMoves],
    ["position startpos moves 7g7f 3c3d", afterMoves],
  ])("normalizes %s", (input, expected) => {
    expect(parseBookSfen(input)).toBe(expected);
  });

  it.each([
    null,
    123,
    {},
    "invalid",
    "position invalid",
    "startpos\n",
    "startpos\0",
    "x".repeat(513),
  ])("rejects invalid book positions: %j", (input) => {
    expect(() => parseBookSfen(input)).toThrowError(
      expect.objectContaining({ name: "HttpError", status: 400 }),
    );
  });
});
