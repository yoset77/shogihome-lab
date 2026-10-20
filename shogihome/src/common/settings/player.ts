import { t } from "@/common/i18n/index";
import type { USIEngine } from "./usi.js";
import * as uri from "@/common/uri";

export type PlayerSettings = {
  name: string;
  uri: string;
  usi?: USIEngine;
};

export function defaultPlayerSettings(): PlayerSettings {
  return {
    name: t.human,
    uri: uri.ES_HUMAN,
  };
}

export function validatePlayerSettings(settings: PlayerSettings): Error | undefined {
  if (!settings.name) {
    return new Error("player name is required");
  }
  if (!settings.uri) {
    return new Error("player URI is required");
  }
  if (settings.uri !== uri.ES_HUMAN && !uri.isLanEngineURI(settings.uri)) {
    return new Error("invalid player URI");
  }
}
