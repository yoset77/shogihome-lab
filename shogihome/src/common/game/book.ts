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

function primaryMoveScore({ score }: BookMove): number {
  return score !== undefined && Number.isFinite(score) ? score : -Infinity;
}

function comparePrimaryBookMoves(a: BookMove, b: BookMove): number {
  const aScore = primaryMoveScore(a);
  const bScore = primaryMoveScore(b);
  return aScore === bScore ? (b.count ?? 1) - (a.count ?? 1) : bScore - aScore;
}

/**
 * Filters book moves by legality (when isValid is given) and evaluation.
 * Evaluation limits require a known score. maxEvalDiff is measured from the
 * highest eligible score before applying depth limits.
 *
 * When a depth limit applies, check the remaining move with the highest known
 * score first, breaking ties (or falling back if no scores are known) by count.
 * If that move fails the depth limit, reject the whole entry. Otherwise, keep
 * only moves that meet the limit.
 */
export function filterBookMoves(
  moves: BookMove[],
  options: BookSearchOptions,
  isValid?: (move: BookMove) => boolean,
): BookMove[] {
  if (options.ignoreRate && Math.random() < options.ignoreRate / 100) return [];
  let filtered = isValid ? moves.filter(isValid) : moves;
  const min = options.turn === Color.BLACK ? options.minEvalBlack : options.minEvalWhite;
  const { maxEvalDiff } = options;
  const hasMaxEvalDiff = maxEvalDiff !== undefined && maxEvalDiff >= 0;
  if (min !== undefined || hasMaxEvalDiff) {
    const scored = filtered.filter(
      (move): move is BookMove & { score: number } =>
        move.score !== undefined &&
        Number.isFinite(move.score) &&
        (min === undefined || move.score >= min),
    );
    if (hasMaxEvalDiff) {
      const bestScore = scored.reduce((best, { score }) => Math.max(best, score), -Infinity);
      filtered = scored.filter(({ score }) => bestScore - score <= maxEvalDiff);
    } else {
      filtered = scored;
    }
  }
  const depthLimit = options.bookDepthLimit ?? 0;
  if (!(depthLimit > 0) || !filtered.length) return filtered;
  const meetsDepthLimit = ({ depth }: BookMove) =>
    depth !== undefined && Number.isFinite(depth) && depth >= depthLimit;
  const primary = filtered.reduce((best, move) =>
    comparePrimaryBookMoves(move, best) < 0 ? move : best,
  );
  return meetsDepthLimit(primary) ? filtered.filter(meetsDepthLimit) : [];
}

export function selectBookMove(moves: BookMove[], options: BookSearchOptions): BookMove {
  if (moves.length <= 1) {
    return moves[0];
  }

  switch (options.moveSelectionRule) {
    case BookMoveSelectionRule.WEIGHTED_BY_COUNT:
      return selectWeightedRandom(moves, (move) => move.count ?? 1);
    case BookMoveSelectionRule.WEIGHTED_BY_SCORE: {
      const scores = moves
        .map((move) => move.score)
        .filter((score): score is number => score !== undefined && Number.isFinite(score));
      if (scores.length === 0) {
        return moves[0];
      }
      const maxScore = Math.max(...scores);
      const temperature =
        Number.isFinite(options.scoreTemperature) && options.scoreTemperature > 0
          ? options.scoreTemperature
          : DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE;
      return selectWeightedRandom(moves, (move) =>
        move.score !== undefined && Number.isFinite(move.score)
          ? Math.exp((move.score - maxScore) / temperature)
          : 0,
      );
    }
    case BookMoveSelectionRule.UNIFORM:
      return moves[Math.floor(Math.random() * moves.length)];
    default:
      return moves[0];
  }
}

function selectWeightedRandom<T>(items: T[], getWeight: (item: T) => number): T {
  const weights = items.map((item) => {
    const weight = getWeight(item);
    return Number.isFinite(weight) && weight > 0 ? weight : 0;
  });
  const maxWeight = Math.max(...weights);
  if (maxWeight <= 0) {
    return items[0];
  }

  const normalizedWeights = weights.map((weight) => weight / maxWeight);
  const total = normalizedWeights.reduce((sum, weight) => sum + weight, 0);
  let remaining = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    remaining -= normalizedWeights[i];
    if (remaining < 0) {
      return items[i];
    }
  }
  return items[items.length - 1];
}
