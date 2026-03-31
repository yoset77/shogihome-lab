import { PlayerSettings } from "@/common/settings/player.js";
import { humanPlayer } from "./human.js";
import { Player, SearchInfo } from "./player.js";
import { USIPlayer } from "./usi.js";
import { BasicPlayer } from "./basic.js";
import * as uri from "@/common/uri.js";
import { LanPlayer } from "./lan_player.js";

export interface PlayerBuilder {
  build(
    playerSettings: PlayerSettings,
    onSearchInfo?: (info: SearchInfo) => void,
    sessionKey?: string,
  ): Promise<Player>;
}

export function defaultPlayerBuilder(engineTimeoutSeconds?: number): PlayerBuilder {
  return {
    async build(
      playerSettings: PlayerSettings,
      onSearchInfo?: (info: SearchInfo) => void,
      sessionKey?: string,
    ): Promise<Player> {
      if (playerSettings.uri === uri.ES_HUMAN) {
        return humanPlayer;
      }
      if (playerSettings.uri === "lan-engine" || playerSettings.uri.startsWith("lan-engine:")) {
        let engineId = "game";
        let engineName = "LAN Engine";
        if (playerSettings.uri.startsWith("lan-engine:")) {
          engineId = playerSettings.uri.split(":")[1];
          engineName = playerSettings.name || engineId;
        }
        const player = new LanPlayer(
          sessionKey || "default",
          engineId,
          engineName,
          onSearchInfo,
          undefined,
          playerSettings.usi?.extraBook,
        );
        await player.launch();
        return player;
      }
      if (uri.isBasicEngine(playerSettings.uri)) {
        return new BasicPlayer(playerSettings.uri);
      }
      if (uri.isUSIEngine(playerSettings.uri) && playerSettings.usi) {
        const player = new USIPlayer(playerSettings.usi, engineTimeoutSeconds ?? 10, onSearchInfo);
        await player.launch();
        return player;
      }
      throw new Error(
        "defaultPlayerBuilder#build: 予期せぬプレイヤーURIです: " + playerSettings.uri,
      );
    },
  };
}
