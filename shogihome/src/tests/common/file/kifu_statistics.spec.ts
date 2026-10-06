import { describe, expect, it } from "vitest";
import { decodeKifuSearchStatistics } from "@/common/file/kifu_statistics";

const valid = {
  total: 1,
  generatedAt: 100,
  strategies: [{ strategy: "角換わり", count: 1 }],
  players: [{ name: "A", black: 1, white: 1, total: 2 }],
};

describe("decodeKifuSearchStatistics", () => {
  it("accepts consistent aggregates and empty results", () => {
    expect(decodeKifuSearchStatistics(valid)).toEqual(valid);
    expect(
      decodeKifuSearchStatistics({ total: 0, generatedAt: 100, strategies: [], players: [] }),
    ).not.toBeNull();
  });
  it.each([
    null,
    [],
    { ...valid, total: -1 },
    { ...valid, generatedAt: "now" },
    { ...valid, strategies: [{ strategy: "unsupported", count: 1 }] },
    { ...valid, strategies: [{ strategy: "raw-only", count: 2 }] },
    { ...valid, players: [{ name: "A", black: 1, white: 0, total: 2 }] },
    { ...valid, players: [{ name: 42, black: 1, white: 1, total: 2 }] },
  ])("rejects malformed or inconsistent aggregates", (value) => {
    expect(decodeKifuSearchStatistics(value)).toBeNull();
  });
});
