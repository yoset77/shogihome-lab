export enum BookMoveSelectionRule {
  UNIFORM = "uniform",
  WEIGHTED_BY_COUNT = "weightedByCount",
  WEIGHTED_BY_SCORE = "weightedByScore",
}

export const DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE = 50;
export const MAX_BOOK_SETTING_VALUE = 1_000_000;

export type USIEngineExtraBookConfig = {
  enabled: boolean;
  filePath: string;
  moveSelectionRule: BookMoveSelectionRule;
  scoreTemperature: number;
  maxMoves?: number;
  minEvalBlack?: number;
  minEvalWhite?: number;
  maxEvalDiff?: number;
  ignoreRate?: number;
  bookDepthLimit?: number;
};

type LegacyUSIEngineExtraBookConfig = Omit<
  Partial<USIEngineExtraBookConfig>,
  "moveSelectionRule"
> & {
  moveSelectionRule?: BookMoveSelectionRule | string;
  considerBookMoveCount?: boolean;
};

export function emptyUSIEngineExtraBookConfig(): USIEngineExtraBookConfig {
  return {
    enabled: false,
    filePath: "",
    moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_COUNT,
    scoreTemperature: DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE,
    maxMoves: 0,
    minEvalBlack: undefined,
    minEvalWhite: undefined,
    maxEvalDiff: undefined,
    ignoreRate: 0,
    bookDepthLimit: 0,
  };
}

function bookNumber(value: unknown, min: number, max = MAX_BOOK_SETTING_VALUE): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

function bookCounter(value: unknown, max = MAX_BOOK_SETTING_VALUE): number | undefined {
  return Number.isSafeInteger(value) ? bookNumber(value, 0, max) : undefined;
}

export function normalizeUSIEngineExtraBookConfig(
  config?: LegacyUSIEngineExtraBookConfig,
): USIEngineExtraBookConfig {
  const defaults = emptyUSIEngineExtraBookConfig();
  if (!config) {
    return defaults;
  }

  const { considerBookMoveCount, ...currentConfig } = config;
  const moveSelectionRule = Object.values(BookMoveSelectionRule).includes(
    currentConfig.moveSelectionRule as BookMoveSelectionRule,
  )
    ? (currentConfig.moveSelectionRule as BookMoveSelectionRule)
    : considerBookMoveCount === false
      ? BookMoveSelectionRule.UNIFORM
      : BookMoveSelectionRule.WEIGHTED_BY_COUNT;
  return {
    ...defaults,
    ...currentConfig,
    moveSelectionRule,
    scoreTemperature:
      bookNumber(currentConfig.scoreTemperature, Number.MIN_VALUE) ?? defaults.scoreTemperature,
    maxMoves: bookCounter(currentConfig.maxMoves) ?? defaults.maxMoves,
    minEvalBlack: bookNumber(currentConfig.minEvalBlack, -MAX_BOOK_SETTING_VALUE),
    minEvalWhite: bookNumber(currentConfig.minEvalWhite, -MAX_BOOK_SETTING_VALUE),
    maxEvalDiff: bookCounter(currentConfig.maxEvalDiff),
    ignoreRate: bookCounter(currentConfig.ignoreRate, 100) ?? defaults.ignoreRate,
    bookDepthLimit: bookCounter(currentConfig.bookDepthLimit) ?? defaults.bookDepthLimit,
  };
}

// Browser settings reference wrapper-managed engines; executable paths and options stay there.
export type USIEngine = {
  uri: string;
  name: string;
  extraBook?: USIEngineExtraBookConfig;
};

export function normalizeUSIEngine(engine: USIEngine): USIEngine {
  return {
    uri: engine.uri,
    name: engine.name,
    ...(engine.extraBook ? { extraBook: normalizeUSIEngineExtraBookConfig(engine.extraBook) } : {}),
  };
}

export function emptyUSIEngine(): USIEngine {
  return {
    uri: "",
    name: "",
    extraBook: emptyUSIEngineExtraBookConfig(),
  };
}
