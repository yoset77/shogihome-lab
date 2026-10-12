import { t } from "@/common/i18n/index";
import { isValidMultiPV, MIN_MULTIPV, MAX_MULTIPV } from "@/common/engine/relay_protocol";
import { normalizeUSIEngine, USIEngine } from "./usi.js";

export type SecondaryResearchSettings = {
  usi?: USIEngine;
};

export type ResearchSettings = {
  usi?: USIEngine;
  secondaries?: SecondaryResearchSettings[];
  enableMaxSeconds: boolean;
  maxSeconds: number;
  overrideMultiPV: boolean;
  multiPV: number;
};

export function defaultResearchSettings(): ResearchSettings {
  return {
    enableMaxSeconds: false,
    maxSeconds: 10,
    overrideMultiPV: false,
    multiPV: 1,
  };
}

export function normalizeResearchSettings(settings: ResearchSettings): ResearchSettings {
  return {
    ...defaultResearchSettings(),
    ...settings,
    ...(settings.usi ? { usi: normalizeUSIEngine(settings.usi) } : {}),
    secondaries: settings.secondaries
      ?.filter(
        (secondary): secondary is SecondaryResearchSettings & { usi: USIEngine } => !!secondary.usi,
      )
      .map((secondary) => ({
        ...secondary,
        usi: normalizeUSIEngine(secondary.usi),
      })),
  };
}

export function validateResearchSettings(settings: ResearchSettings): Error | undefined {
  if (!settings.usi) {
    return new Error(t.engineNotSelected);
  }
  if (settings.secondaries?.some((secondary) => !secondary.usi)) {
    return new Error(t.engineNotSelected);
  }
  if (settings.overrideMultiPV && !isValidMultiPV(settings.multiPV)) {
    return new Error(t.multiPVInvalid(MIN_MULTIPV, MAX_MULTIPV));
  }
}
