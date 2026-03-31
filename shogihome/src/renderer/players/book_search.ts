import { ImmutablePosition, Move } from "tsshogi";
import api from "@/renderer/ipc/api";
import { LogLevel } from "@/common/log";
import { USIInfoCommand } from "@/common/game/usi";
import { dispatchUSIInfoUpdate, triggerOnStartSearch } from "./usi_events";

/**
 * Searches for book moves and reports them to the player.
 * @param sessionID The player's session ID.
 * @param position The current position.
 * @param bookSessionID The book session ID.
 * @param engineName The name of the engine (used for display).
 * @param currentUSI The current position in USI format (to ensure consistency).
 * @param onMove A callback called with the best move if found.
 * @returns A promise that resolves to true if book moves were found and handled.
 */
export async function searchBookMovesForPlayer(
  sessionID: number,
  position: ImmutablePosition,
  bookSessionID: string,
  engineName: string,
  currentUSI: string | undefined,
  onMove: (move: Move) => void,
): Promise<boolean> {
  try {
    // 定跡を検索
    const bookMoves = await api.searchBookMoves(position.sfen, bookSessionID);
    if (bookMoves.length === 0) {
      return false;
    }

    // 読み筋表示を初期化
    triggerOnStartSearch(sessionID, position);

    // 定跡に登録されている手の一覧を表示
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

    // 最善手を返却
    const bestMove = bookMoves[0];
    const move = position.createMoveByUSI(bestMove.usi);
    if (!move) {
      api.log(
        LogLevel.ERROR,
        `Failed to search book moves: invalid move from book: ${bestMove.usi}`,
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
