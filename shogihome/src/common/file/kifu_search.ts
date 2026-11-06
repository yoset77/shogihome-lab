import type { KifuSearchQuery } from "./sfen_export";
import { searchableStrategies, UNCLASSIFIED_STRATEGY } from "@/common/kifu/strategy_taxonomy";

export const MAX_KIFU_KEYWORD_LENGTH = 1_024;
export const MAX_KIFU_KEYWORDS = 16;
export const MAX_KIFU_KEYWORD_WORD_LENGTH = 128;
export const MAX_KIFU_SEARCH_LIMIT = 1_000;

export function readKifuSearchQuery(value: unknown): KifuSearchQuery {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid search query");
  const input = value as Record<string, unknown>;
  const query: KifuSearchQuery = {};
  const limits = {
    sfen: 1_024,
    keyword: MAX_KIFU_KEYWORD_LENGTH,
    player1: 128,
    player2: 128,
    startDate: 32,
  };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const text = input[key];
    if (text !== undefined) {
      if (typeof text !== "string" || text.length > limits[key])
        throw new Error("Invalid search text");
      query[key] = text;
    }
  }
  if (query.keyword) {
    const words = query.keyword.split(/\s+/).filter(Boolean);
    if (
      words.length > MAX_KIFU_KEYWORDS ||
      words.some((word) => word.length > MAX_KIFU_KEYWORD_WORD_LENGTH)
    )
      throw new Error("Search keyword limit exceeded");
  }
  if (input.isStrictTurn !== undefined) {
    if (typeof input.isStrictTurn !== "boolean") throw new Error("Invalid search turn filter");
    query.isStrictTurn = input.isStrictTurn;
  }
  if (input.strategy !== undefined && input.strategy !== "") {
    if (
      input.strategy !== UNCLASSIFIED_STRATEGY &&
      !searchableStrategies.some((strategy) => strategy === input.strategy)
    )
      throw new Error("Invalid search strategy");
    query.strategy = input.strategy as KifuSearchQuery["strategy"];
  }
  return query;
}

export function validateKifuSearchPagination(limit?: number, offset?: number): void {
  if (
    (limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_KIFU_SEARCH_LIMIT)) ||
    (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
  )
    throw new Error("Invalid search pagination");
}
