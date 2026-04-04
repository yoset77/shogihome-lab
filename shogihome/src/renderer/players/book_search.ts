import { Color, ImmutablePosition, Move } from "tsshogi";
import api from "@/renderer/ipc/api";
import { LogLevel } from "@/common/log";
import { USIInfoCommand } from "@/common/game/usi";
import { dispatchUSIInfoUpdate, triggerOnStartSearch } from "./usi_events";
import { BookMove } from "@/common/book";

export interface BookSearchOptions {
  considerBookMoveCount: boolean;
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
    const bookMoves = await api.searchBookMoves(position.sfen, bookSessionID);
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
    const selectedMove = selectBookMove(filteredMoves, options.considerBookMoveCount);
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

function selectBookMove(moves: BookMove[], considerMoveCount: boolean): BookMove {
  if (moves.length <= 1) {
    return moves[0];
  }

  if (considerMoveCount) {
    const total = moves.reduce((sum, m) => sum + (m.count ?? 1), 0);
    let r = Math.random() * total;
    for (const move of moves) {
      r -= move.count ?? 1;
      if (r <= 0) {
        return move;
      }
    }
  } else {
    // Uniform random
    const index = Math.floor(Math.random() * moves.length);
    return moves[index];
  }

  return moves[0];
}
