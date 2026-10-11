import { searchableStrategies, type SearchableStrategy } from "@/common/kifu/strategy_taxonomy";

export const KIFU_STATISTICS_PLAYER_LIMIT = 50;

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
  otherPlayers: { black: number; white: number; total: number };
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
const isPlayerCounts = (value: unknown): value is KifuSearchStatistics["otherPlayers"] =>
  isObject(value) &&
  isCount(value.black) &&
  isCount(value.white) &&
  isCount(value.total) &&
  value.total === value.black + value.white;

export function decodeKifuSearchStatistics(value: unknown): KifuSearchStatistics | null {
  if (
    !isObject(value) ||
    !isCount(value.total) ||
    !isCount(value.generatedAt) ||
    !Array.isArray(value.strategies) ||
    !Array.isArray(value.players) ||
    value.players.length > KIFU_STATISTICS_PLAYER_LIMIT ||
    !isPlayerCounts(value.otherPlayers)
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
        isObject(row) && (row.name === null || typeof row.name === "string") && isPlayerCounts(row),
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
  const playerTotals = statistics.players.reduce(
    (sum, row) => ({
      black: sum.black + row.black,
      white: sum.white + row.white,
      total: sum.total + row.total,
    }),
    statistics.otherPlayers,
  );
  if (
    statistics.strategies.reduce((sum, row) => sum + row.count, 0) !== statistics.total ||
    playerTotals.black !== statistics.total ||
    playerTotals.white !== statistics.total ||
    playerTotals.total !== statistics.total * 2 ||
    (statistics.nextMoves !== undefined &&
      statistics.nextMoves.reduce((sum, row) => sum + row.count, 0) !== statistics.total)
  )
    return null;
  return statistics;
}
