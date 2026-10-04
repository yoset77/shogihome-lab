import { type ImmutablePosition, type Move } from "tsshogi";
import { filterBookMoves, selectBookMove } from "@/common/game/book";
import { flippedSFEN, flippedUSIMove } from "@/common/helpers/sfen";
import type { USIEngineExtraBookConfig } from "@/common/settings/usi";
import type { USIInfoCommand } from "@/common/game/usi";
import { closeBookSession, openBookAsNewSession, searchBookMoves } from "@/server/book";
import { KIFU_DIR, ONTHEFLY_THRESHOLD_MB, SBK_ONTHEFLY_THRESHOLD_MB } from "@/server/config";
import { resolveKifuPath, getServerFileKind } from "@/server/helpers/kifu";

export class GameBook {
  private constructor(private readonly session: number) {}
  static async open(config: USIEngineExtraBookConfig): Promise<GameBook> {
    const relative = config.filePath.substring(9);
    const path =
      KIFU_DIR &&
      config.filePath.startsWith("server://") &&
      getServerFileKind(relative) === "book" &&
      resolveKifuPath(KIFU_DIR, relative);
    if (!path) throw new Error("Invalid game book path");
    const result = await openBookAsNewSession(path, {
      onTheFlyThresholdMB: ONTHEFLY_THRESHOLD_MB,
      sbkOnTheFlyThresholdMB: SBK_ONTHEFLY_THRESHOLD_MB,
    });
    return new GameBook(result.session);
  }
  search(sfen: string) {
    return searchBookMoves(this.session, sfen);
  }
  close(): void {
    closeBookSession(this.session);
  }
}

export async function searchGameBook(
  book: GameBook,
  position: ImmutablePosition,
  usi: string,
  config: USIEngineExtraBookConfig,
  signal: AbortSignal,
  onInfo: (info: USIInfoCommand) => void,
): Promise<Move | undefined> {
  if (signal.aborted) return;
  let onAbort!: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const lookup = async () => {
    if (!config.enabled) return;
    const movesIndex = usi.indexOf(" moves ");
    const ply = movesIndex < 0 ? 0 : usi.substring(movesIndex + 7).split(" ").length;
    if (config.maxMoves && ply >= config.maxMoves) return;
    try {
      let moves = await book.search(position.sfen);
      if (signal.aborted) return;
      if (!moves.length)
        moves = (await book.search(flippedSFEN(position.sfen))).map((move) => ({
          ...move,
          usi: flippedUSIMove(move.usi),
          ...(move.usi2 ? { usi2: flippedUSIMove(move.usi2) } : {}),
        }));
      if (signal.aborted) return;
      const options = { ...config, turn: position.color };
      const candidates = filterBookMoves(moves, options).filter((candidate) => {
        const move = position.createMoveByUSI(candidate.usi);
        return move && position.isValidMove(move);
      });
      if (!candidates.length) return;
      for (const [index, move] of moves.slice(0, 32).entries())
        onInfo({
          multipv: index + 1,
          depth: move.depth,
          nodes: move.count,
          scoreCP: move.score,
          pv: move.usi2 ? [move.usi, move.usi2] : [move.usi],
        });
      return position.createMoveByUSI(selectBookMove(candidates, options).usi) ?? undefined;
    } catch (error) {
      if (!signal.aborted) console.warn("Game book search failed; falling back to engine", error);
    }
  };
  try {
    return await Promise.race([lookup(), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
