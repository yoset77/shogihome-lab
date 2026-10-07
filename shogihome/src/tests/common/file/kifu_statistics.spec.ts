import { describe, expect, it } from "vitest";
import { decodeKifuSearchStatistics } from "@/common/file/kifu_statistics";

const valid = {
  total: 1,
  generatedAt: 100,
  strategies: [{ strategy: "角換わり", count: 1 }],
  players: [{ name: "A", black: 1, white: 1, total: 2 }],
};

const validNextMoves = {
  total: 3,
  generatedAt: 100,
  strategies: [{ strategy: "角換わり", count: 3 }],
  players: [{ name: "A", black: 3, white: 3, total: 6 }],
  nextMoves: [
    { move: "☗２五歩", count: 1 },
    { move: "", count: 1 },
    { move: null, count: 1 },
  ],
};

describe("decodeKifuSearchStatistics", () => {
  it("accepts consistent aggregates and empty results", () => {
    expect(decodeKifuSearchStatistics(valid)).toEqual(valid);
    expect(
      decodeKifuSearchStatistics({ total: 0, generatedAt: 100, strategies: [], players: [] }),
    ).not.toBeNull();
  });
  it("accepts next move aggregates including empty and unavailable moves", () => {
    expect(decodeKifuSearchStatistics(validNextMoves)).toEqual(validNextMoves);
    expect(
      decodeKifuSearchStatistics({ ...valid, nextMoves: [{ move: "☗２五歩", count: 1 }] }),
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
    { ...valid, nextMoves: "invalid" },
    { ...valid, nextMoves: [{ move: 42, count: 1 }] },
    { ...valid, nextMoves: [{ move: "☗２五歩" }] },
    { ...valid, nextMoves: [{ move: "☗２五歩", count: -1 }] },
    { ...valid, nextMoves: [] },
    { ...valid, nextMoves: [{ move: null, count: 2 }] },
    {
      ...validNextMoves,
      nextMoves: [
        { move: "☗２五歩", count: 1 },
        { move: "☗２五歩", count: 2 },
      ],
    },
  ])("rejects malformed or inconsistent aggregates", (value) => {
    expect(decodeKifuSearchStatistics(value)).toBeNull();
  });
});
