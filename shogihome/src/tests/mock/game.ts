import { GameSettings, JishogiRule } from "@/common/settings/game";
import { InitialPositionType } from "tsshogi";

export const playerURI01 = "lan-engine:test-engine-01";
export const playerURI02 = "lan-engine:test-engine-02";

const blackPlayerSettings = {
  name: "USI Engine 01",
  uri: playerURI01,
  usi: {
    uri: playerURI01,
    name: "my usi engine 01",
  },
};

const whitePlayerSettings = {
  name: "USI Engine 02",
  uri: playerURI02,
  usi: {
    uri: playerURI02,
    name: "my usi engine 02",
  },
};

export const timeLimitSettings = {
  timeSeconds: 600,
  byoyomi: 30,
  increment: 0,
};

export const gameSettings10m30s: GameSettings = {
  black: blackPlayerSettings,
  white: whitePlayerSettings,
  timeLimit: timeLimitSettings,
  startPosition: InitialPositionType.STANDARD,
  startPositionListFile: "",
  startPositionListOrder: "sequential",
  enableEngineTimeout: false,
  humanIsFront: false,
  enableComment: true,
  enableAutoSave: true,
  autoSaveDirectory: "server://",
  repeat: 1,
  swapPlayers: true,
  maxMoves: 1000,
  jishogiRule: JishogiRule.NONE,
};
