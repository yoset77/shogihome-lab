import { exportKIF } from "tsshogi";
import type { GameRecordSummary, GameSaveOptions } from "@/common/game/protocol";
import type { GameSettings } from "@/common/settings/game";
import { restoreRecord, type RecordSnapshot } from "@/common/record/snapshot";
import { addHistory, saveBackup } from "@/server/file/history";
import { saveGameRecord } from "./files";

export type GamePersistence = {
  saveRecord?: typeof saveGameRecord;
  addHistory?: typeof addHistory;
  saveBackup?: typeof saveBackup;
};

/** Share the same file/history recovery policy between serial and parallel games. */
export async function persistGameRecord(
  source: RecordSnapshot,
  options: GameSaveOptions,
  settings: Pick<GameSettings, "enableAutoSave" | "autoSaveDirectory">,
  summary: GameRecordSummary,
  deps: GamePersistence,
  onError: () => void,
): Promise<void> {
  if (settings.enableAutoSave) {
    try {
      summary.path = await (deps.saveRecord ?? saveGameRecord)(
        source,
        { ...options, directory: settings.autoSaveDirectory },
        summary.gameId,
      );
      summary.state = "saved";
    } catch (error) {
      console.error("Game save failed", error);
      summary.state = "failed";
      onError();
    }
  }
  try {
    if (summary.state === "saved") {
      await (deps.addHistory ?? addHistory)("server://" + summary.path);
    } else {
      await (deps.saveBackup ?? saveBackup)(
        exportKIF(restoreRecord(source).record, { returnCode: options.returnCode }),
      );
    }
  } catch (error) {
    console.error("Game history failed", error);
    summary.state = "failed";
    onError();
  }
}
