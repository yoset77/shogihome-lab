import { Color } from "tsshogi";
import type { BookMove } from "@/common/book";
import { BookMoveSelectionRule, DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE } from "@/common/settings/usi";

export interface BookSearchOptions {
  moveSelectionRule: BookMoveSelectionRule;
  scoreTemperature: number;
  turn: Color;
  minEvalBlack?: number;
  minEvalWhite?: number;
  maxEvalDiff?: number;
  ignoreRate?: number;
  bookDepthLimit?: number;
}

export function filterBookMoves(moves: BookMove[], options: BookSearchOptions): BookMove[] {
  if (options.ignoreRate && Math.random() < options.ignoreRate / 100) return [];
  let filtered = moves.filter(
    (move) =>
      !options.bookDepthLimit || move.depth === undefined || move.depth >= options.bookDepthLimit,
  );
  const min = options.turn === Color.BLACK ? options.minEvalBlack : options.minEvalWhite;
  if (min !== undefined)
    filtered = filtered.filter((move) => move.score === undefined || move.score >= min);
  if (options.maxEvalDiff !== undefined && options.maxEvalDiff >= 0) {
    const best = Math.max(...filtered.map((move) => move.score ?? -Infinity));
    filtered = filtered.filter(
      (move) => move.score === undefined || best - move.score <= options.maxEvalDiff!,
    );
  }
  return filtered;
}

export function selectBookMove(moves: BookMove[], options: BookSearchOptions): BookMove {
  if (moves.length <= 1) return moves[0];
  if (options.moveSelectionRule === BookMoveSelectionRule.UNIFORM)
    return moves[Math.floor(Math.random() * moves.length)];
  let weights: number[];
  if (options.moveSelectionRule === BookMoveSelectionRule.WEIGHTED_BY_COUNT)
    weights = moves.map((move) => move.count ?? 1);
  else if (options.moveSelectionRule === BookMoveSelectionRule.WEIGHTED_BY_SCORE) {
    const max = Math.max(...moves.map((move) => move.score ?? -Infinity));
    if (!Number.isFinite(max)) return moves[0];
    const temperature =
      options.scoreTemperature > 0 && Number.isFinite(options.scoreTemperature)
        ? options.scoreTemperature
        : DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE;
    weights = moves.map((move) =>
      move.score === undefined ? 0 : Math.exp((move.score - max) / temperature),
    );
  } else return moves[0];
  weights = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const max = Math.max(...weights);
  if (max === 0) return moves[0];
  weights = weights.map((weight) => weight / max);
  let choice = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < moves.length; index++) {
    choice -= weights[index];
    if (choice < 0) return moves[index];
  }
  return moves[moves.length - 1];
}
