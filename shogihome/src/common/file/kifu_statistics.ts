import { searchableStrategies, type SearchableStrategy } from "@/common/kifu/strategy_taxonomy";

export type KifuStatisticsStrategy = SearchableStrategy | "raw-only" | "unclassified";

// move is the recorded continuation of the representative position: an empty
// string means no continuation, and null means the next move is not indexed yet.
export interface KifuStatisticsNextMove {
  move: string | null;
  count: number;
}

export interface KifuSearchStatistics {
  total: number;
  generatedAt: number;
  strategies: { strategy: KifuStatisticsStrategy; count: number }[];
  players: { name: string | null; black: number; white: number; total: number }[];
  nextMoves?: KifuStatisticsNextMove[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNextMove = (value: unknown): value is KifuStatisticsNextMove =>
  isObject(value) &&
  (typeof value.move === "string" || value.move === null) &&
  isCount(value.count);

export function decodeKifuSearchStatistics(value: unknown): KifuSearchStatistics | null {
  if (
    !isObject(value) ||
    !isCount(value.total) ||
    !isCount(value.generatedAt) ||
    !Array.isArray(value.strategies) ||
    !Array.isArray(value.players)
  )
    return null;
  if (
    !value.strategies.every(
      (row: unknown) =>
        isObject(row) &&
        isCount(row.count) &&
        [...searchableStrategies, "raw-only", "unclassified"].includes(row.strategy as string),
    )
  )
    return null;
  if (
    !value.players.every(
      (row: unknown) =>
        isObject(row) &&
        (row.name === null || typeof row.name === "string") &&
        isCount(row.black) &&
        isCount(row.white) &&
        isCount(row.total) &&
        row.total === row.black + row.white,
    )
  )
    return null;
  if (value.nextMoves !== undefined) {
    const nextMoves = value.nextMoves;
    if (
      !Array.isArray(nextMoves) ||
      !nextMoves.every(isNextMove) ||
      new Set(nextMoves.map((row: KifuStatisticsNextMove) => row.move)).size !== nextMoves.length
    )
      return null;
  }
  const statistics = value as unknown as KifuSearchStatistics;
  if (
    statistics.strategies.reduce((sum, row) => sum + row.count, 0) !== statistics.total ||
    statistics.players.reduce((sum, row) => sum + row.total, 0) !== statistics.total * 2 ||
    (statistics.nextMoves !== undefined &&
      statistics.nextMoves.reduce((sum, row) => sum + row.count, 0) !== statistics.total)
  )
    return null;
  return statistics;
}
