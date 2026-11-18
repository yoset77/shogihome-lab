import { ImmutablePosition, Move } from "tsshogi";
import api from "@/renderer/ipc/api";
import { LogLevel } from "@/common/log";
import { USIInfoCommand } from "@/common/game/usi";
import { dispatchUSIInfoUpdate, triggerOnStartSearch } from "./usi_events";
import { filterBookMoves, selectBookMove, type BookSearchOptions } from "@/common/game/book";
import { flippedSFEN, flippedUSIMove } from "@/common/helpers/sfen";

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
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    let bookMoves = await api.searchBookMoves(position.sfen, bookSessionID);
    if (signal?.aborted) return false;
    if (bookMoves.length === 0) {
      bookMoves = (await api.searchBookMoves(flippedSFEN(position.sfen), bookSessionID)).map(
        (move) => ({
          ...move,
          usi: flippedUSIMove(move.usi),
          ...(move.usi2 ? { usi2: flippedUSIMove(move.usi2) } : {}),
        }),
      );
    }
    if (signal?.aborted) return false;
    if (bookMoves.length === 0) {
      return false;
    }

    // Rejecting the entry here makes the engine search on its own.
    const filteredMoves = filterBookMoves(bookMoves, options, (candidate) => {
      const move = position.createMoveByUSI(candidate.usi);
      return move !== null && position.isValidMove(move);
    });
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
