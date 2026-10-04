import type { Texts } from "@/common/i18n/text_template";
import type { AppSettings } from "@/common/settings/app";

export function getSituationText(score: number): string {
  if (score >= 1500) return "先手勝勢";
  if (score >= 600) return "先手優勢";
  if (score >= 400) return "先手有利";
  if (score >= 200) return "先手有望";
  if (score > -200) return "互角";
  if (score > -400) return "後手有望";
  if (score > -600) return "後手有利";
  if (score > -1500) return "後手優勢";
  return "後手勝勢";
}

export function scoreToPercentage(score: number, coefficientInSigmoid: number): number {
  return 100 / (1 + Math.exp(-score / coefficientInSigmoid));
}

export type AccuracySettings = Pick<
  AppSettings,
  | "coefficientInSigmoid"
  | "badMoveLevelThreshold1"
  | "badMoveLevelThreshold2"
  | "badMoveLevelThreshold3"
  | "badMoveLevelThreshold4"
>;

export function getMoveAccuracyText(
  before: number,
  after: number,
  settings: AccuracySettings,
  texts: Pick<Texts, "blunder" | "mistake" | "dubious" | "inaccuracy">,
): string | null {
  const loss =
    scoreToPercentage(before, settings.coefficientInSigmoid) -
    scoreToPercentage(after, settings.coefficientInSigmoid);
  if (loss >= settings.badMoveLevelThreshold4) return texts.blunder;
  if (loss >= settings.badMoveLevelThreshold3) return texts.mistake;
  if (loss >= settings.badMoveLevelThreshold2) return texts.dubious;
  if (loss >= settings.badMoveLevelThreshold1) return texts.inaccuracy;
  return null;
}
