import type { GameSettings } from "@/common/settings/game";
import { GameRecord } from "@/common/game/record";
import { restoreRecord, type RecordSnapshot } from "@/common/record/snapshot";
import { getTranslationTable } from "@/common/i18n/translation_table";
import type { Language } from "@/common/i18n/languages";
import { StartPositionList } from "./controller";
import { loadGamePositions } from "./files";

export type GameAssignment = { gameNumber: number; swapped: boolean };
export interface GameCoordinator {
  next(records: GameRecord): GameAssignment | undefined;
}

/** One synchronous allocator preserves global color/position pairing across workers. */
export async function buildGameCoordinator(
  settings: GameSettings,
  source: RecordSnapshot,
  language: Language,
  loadPositions = loadGamePositions,
): Promise<GameCoordinator> {
  const positions = new StartPositionList(loadPositions);
  if (settings.startPosition === "list") {
    await positions.reset({
      filePath: settings.startPositionListFile,
      swapPlayers: settings.swapPlayers,
      order: settings.startPositionListOrder,
      maxGames: settings.repeat,
      ply: settings.startPositionListPly,
    });
  }
  let assigned = 0;
  return {
    next(records) {
      if (assigned >= settings.repeat) return;
      const gameNumber = ++assigned;
      switch (settings.startPosition) {
        case "current":
          records.record = restoreRecord(source).record;
          break;
        case "list":
          records.importRecord(positions.next());
          records.updateComment(getTranslationTable(language).beginFromThisPosition);
          break;
        default:
          records.resetByInitialPositionType(settings.startPosition);
      }
      return { gameNumber, swapped: settings.swapPlayers && gameNumber % 2 === 0 };
    },
  };
}
