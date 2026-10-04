import { Record } from "tsshogi";
import { snapshotRecord } from "@/common/record/snapshot";
import { defaultGameSettings } from "@/common/settings/game";
import { Language } from "@/common/i18n/languages";
import { SearchCommentFormat } from "@/common/settings/comment";
import { RecordFileFormat } from "@/common/file/record";
import type {
  GameSessionRequest,
  GameCommand,
  GameCommandAction,
  GameSnapshot,
} from "@/common/game/protocol";
import type { Player, SearchHandler } from "@/common/game/player";
import { HumanPlayer } from "@/server/game/player";

export function gameRequest(record = new Record()): GameSessionRequest {
  return {
    requestId: "request",
    serverInstanceId: "server",
    controllerId: "controller",
    source: snapshotRecord(record),
    settings: {
      ...defaultGameSettings(),
      timeLimit: { timeSeconds: 60, byoyomi: 10, increment: 0 },
      enableAutoSave: false,
      enableComment: false,
    },
    options: {
      engineTimeoutSeconds: 10,
      commentFormat: SearchCommentFormat.SHOGIHOME,
      language: Language.JA,
      save: {
        directory: "",
        template: "{datetime}",
        format: RecordFileFormat.KIFU,
        returnCode: "\n",
        useCSAV3: false,
        useUTF8ForKifAndKi2: false,
      },
    },
  };
}
let nextCommand = 0;
export function gameCommand(
  snapshot: GameSnapshot,
  action: GameCommandAction,
  fields: Partial<GameCommand> = {},
): GameCommand {
  return {
    requestId: `command-${++nextCommand}`,
    serverInstanceId: snapshot.serverInstanceId,
    controllerId: "controller",
    controllerEpoch: snapshot.controllerEpoch,
    gameId: snapshot.gameId,
    interactionId: snapshot.interactionId,
    action,
    ...fields,
  };
}
export function fakeGamePlayer() {
  const searches: { usi: string; handler: SearchHandler }[] = [];
  const player: Player = {
    isEngine: () => true,
    supportsTakeback: true,
    readyNewGame: vi.fn(async () => {}),
    startSearch: vi.fn(async (_position, usi, _times, handler) => {
      searches.push({ usi, handler });
    }),
    startPonder: vi.fn(async () => {}),
    startMateSearch: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancelSearch: vi.fn(async () => {}),
    gameover: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return {
    player,
    searches,
    builder: {
      build: async (settings: { uri: string }) =>
        settings.uri === "es://human" ? new HumanPlayer() : player,
    },
  };
}
