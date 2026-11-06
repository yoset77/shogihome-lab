import {
  MAX_KIFU_KEYWORD_LENGTH,
  MAX_KIFU_KEYWORDS,
  MAX_KIFU_KEYWORD_WORD_LENGTH,
  MAX_KIFU_SEARCH_LIMIT,
  readKifuSearchQuery,
  validateKifuSearchPagination,
} from "@/common/file/kifu_search";
import { readBatchSource } from "@/common/analysis/batch";

export const invalidKifuSearchQueries = [
  { keyword: "x".repeat(MAX_KIFU_KEYWORD_LENGTH + 1) },
  {
    keyword: Array(MAX_KIFU_KEYWORDS + 1)
      .fill("x")
      .join(" "),
  },
  { keyword: "x".repeat(MAX_KIFU_KEYWORD_WORD_LENGTH + 1) },
  { player1: "x".repeat(129) },
  { player2: "x".repeat(129) },
  { startDate: "x".repeat(33) },
  { sfen: "x".repeat(1_025) },
  { keyword: ["x", "y"] },
  { isStrictTurn: "" },
  { isStrictTurn: "false" },
  { isStrictTurn: "true" },
  { strategy: "unsupported" },
];

describe("shared record search validation", () => {
  it.each([null, [], ...invalidKifuSearchQueries])("rejects invalid filters: %j", (query) => {
    expect(() => readKifuSearchQuery(query)).toThrow();
    expect(() => readBatchSource({ kind: "search", search: query })).toThrow();
  });

  it("accepts boundary values and whitespace without truncating input", () => {
    const query = {
      keyword: Array(MAX_KIFU_KEYWORDS).fill("x".repeat(63)).join(" ") + " ",
      player1: "x".repeat(128),
      player2: "y".repeat(128),
      startDate: "2026/11/07",
      isStrictTurn: true,
      strategy: "unclassified" as const,
    };
    expect(query.keyword).toHaveLength(MAX_KIFU_KEYWORD_LENGTH);
    expect(readKifuSearchQuery(query)).toEqual(query);
    expect(readBatchSource({ kind: "search", search: query })).toEqual({
      kind: "search",
      search: query,
    });
    expect(readKifuSearchQuery({ keyword: "a\t b\n c　d" }).keyword).toBe("a\t b\n c　d");
    expect(
      readKifuSearchQuery({ keyword: "x".repeat(MAX_KIFU_KEYWORD_WORD_LENGTH) }).keyword,
    ).toHaveLength(MAX_KIFU_KEYWORD_WORD_LENGTH);
  });

  it("allows bounded numeric pagination including the default values", () => {
    expect(() => validateKifuSearchPagination()).not.toThrow();
    expect(() => validateKifuSearchPagination(1, 0)).not.toThrow();
    expect(() =>
      validateKifuSearchPagination(MAX_KIFU_SEARCH_LIMIT, Number.MAX_SAFE_INTEGER),
    ).not.toThrow();
  });

  it.each([-1, 0, 1.5, NaN, Infinity, MAX_KIFU_SEARCH_LIMIT + 1])(
    "rejects invalid limits: %s",
    (limit) => {
      expect(() => validateKifuSearchPagination(limit)).toThrow();
    },
  );
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid offsets: %s",
    (offset) => {
      expect(() => validateKifuSearchPagination(100, offset)).toThrow();
    },
  );
});
