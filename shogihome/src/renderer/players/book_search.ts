import { Color, ImmutablePosition, Move } from "tsshogi";
import api from "@/renderer/ipc/api";
import { LogLevel } from "@/common/log";
import { USIInfoCommand } from "@/common/game/usi";
import { dispatchUSIInfoUpdate, triggerOnStartSearch } from "./usi_events";
import { BookMove } from "@/common/book";
import { BookMoveSelectionRule, DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE } from "@/common/settings/usi";
import { flippedSFEN, flippedUSIMove } from "@/common/helpers/sfen";

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

/**
 * Searches for book moves and reports them to the player.
 * @param sessionID The player's session ID.
 * @param position The current position.
 * @param bookSessionID The book session ID.
 * @param engineName The name of the engine (used for display).
 * @param options Book search configuration.
 * @param currentUSI The current position in USI format (to ensure consistency).
 * @param onMove A callback called with the best move if found.
 * @returns A promise that resolves to true if book moves were found and handled.
 */
export async function searchBookMovesForPlayer(
  sessionID: number,
  position: ImmutablePosition,
  bookSessionID: string,
  engineName: string,
  options: BookSearchOptions,
  currentUSI: string | undefined,
  onMove: (move: Move) => void,
): Promise<boolean> {
  try {
    let bookMoves = await api.searchBookMoves(position.sfen, bookSessionID);
    if (bookMoves.length === 0) {
      bookMoves = (await api.searchBookMoves(flippedSFEN(position.sfen), bookSessionID)).map(
        (move) => ({
          ...move,
          usi: flippedUSIMove(move.usi),
          ...(move.usi2 ? { usi2: flippedUSIMove(move.usi2) } : {}),
        }),
      );
    }
    if (bookMoves.length === 0) {
      return false;
    }

    // Apply ignoreRate: randomly skip book and fall back to engine search
    // ignoreRate is stored as percentage (0-100), convert to probability (0.0-1.0)
    const ignoreRate = (options.ignoreRate ?? 0) / 100;
    if (ignoreRate > 0 && Math.random() < ignoreRate) {
      return false;
    }

    // Apply bookDepthLimit filter
    let filteredMoves = bookMoves;
    const depthLimit = options.bookDepthLimit ?? 0;
    if (depthLimit > 0) {
      filteredMoves = filteredMoves.filter((m) => m.depth === undefined || m.depth >= depthLimit);
    }

    // Apply minEval filter
    const minEval = options.turn === Color.BLACK ? options.minEvalBlack : options.minEvalWhite;
    if (typeof minEval === "number") {
      filteredMoves = filteredMoves.filter((m) => m.score === undefined || m.score >= minEval);
    }

    // Apply maxEvalDiff filter
    if (typeof options.maxEvalDiff === "number" && options.maxEvalDiff >= 0) {
      const bestScore = Math.max(...filteredMoves.map((m) => m.score ?? -Infinity));
      if (bestScore > -Infinity) {
        filteredMoves = filteredMoves.filter(
          (m) => m.score === undefined || bestScore - m.score <= options.maxEvalDiff!,
        );
      }
    }

    if (filteredMoves.length === 0) {
      return false;
    }

    // Display all original book moves as PV lines
    triggerOnStartSearch(sessionID, position);
    if (currentUSI) {
      for (let i = 0; i < bookMoves.length; i++) {
        const bookMove = bookMoves[i];
        const move = position.createMoveByUSI(bookMove.usi);
        if (move) {
          const info: USIInfoCommand = {
            multipv: i + 1,
            depth: bookMove.depth,
            scoreCP: bookMove.score,
            nodes: bookMove.count,
            currmove: bookMove.usi,
            pv: bookMove.usi2 ? [bookMove.usi, bookMove.usi2] : [bookMove.usi],
          };
          dispatchUSIInfoUpdate(sessionID, position, engineName, info);
        }
      }
    }

    // Select a move from filtered candidates
    const selectedMove = selectBookMove(filteredMoves, options);
    const move = position.createMoveByUSI(selectedMove.usi);
    if (!move) {
      api.log(
        LogLevel.ERROR,
        `Failed to search book moves: invalid move from book: ${selectedMove.usi}`,
      );
      return false;
    }

    onMove(move);
    return true;
  } catch (e) {
    api.log(LogLevel.ERROR, `Failed to search book moves: ${e}`);
    return false;
  }
}

function selectBookMove(moves: BookMove[], options: BookSearchOptions): BookMove {
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
