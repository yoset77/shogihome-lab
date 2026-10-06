import { searchableStrategies, type SearchableStrategy } from "@/common/kifu/strategy_taxonomy";

export type KifuStatisticsStrategy = SearchableStrategy | "raw-only" | "unclassified";

export interface KifuSearchStatistics {
  total: number;
  generatedAt: number;
  strategies: { strategy: KifuStatisticsStrategy; count: number }[];
  players: { name: string | null; black: number; white: number; total: number }[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

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
  const statistics = value as unknown as KifuSearchStatistics;
  if (
    statistics.strategies.reduce((sum, row) => sum + row.count, 0) !== statistics.total ||
    statistics.players.reduce((sum, row) => sum + row.total, 0) !== statistics.total * 2
  )
    return null;
  return statistics;
}
