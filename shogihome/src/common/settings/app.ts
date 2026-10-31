import { Language, t } from "@/common/i18n/index";
import { RecordFileFormat } from "@/common/file/record";
import { defaultRecordFileNameTemplate } from "@/common/file/path";
import { BookFormat, isBookFormat } from "@/common/book";
import { BoardLayoutType, EvaluationChartType } from "./layout.js";
import { SearchCommentFormat } from "./comment.js";

export enum Thema {
  STANDARD = "standard",
  CHERRY_BLOSSOM = "cherry-blossom",
  AUTUMN = "autumn",
  SNOW = "snow",
  CLASSIC = "classic",
  BEIGE = "beige",
  DARK_GREEN = "dark-green",
  DARK = "dark",
}

export enum PieceImageType {
  HITOMOJI = "hitomoji",
  HITOMOJI_WOOD = "hitomojiWood",
  HITOMOJI_DARK = "hitomojiDark",
  HITOMOJI_GOTHIC = "hitomojiGothic",
  HITOMOJI_GOTHIC_DARK = "hitomojiGothicDark",
  FUTAMOJI = "futamoji",
}

export enum KingPieceType {
  GYOKU_AND_OSHO = "gyokuAndOsho",
  GYOKU_AND_GYOKU = "gyokuAndGyoku",
}

export enum BoardImageType {
  LIGHT = "light",
  LIGHT2 = "light2",
  LIGHT3 = "light3",
  WARM = "warm",
  WARM2 = "warm2",
  RESIN = "resin",
  RESIN2 = "resin2",
  RESIN3 = "resin3",
  GREEN = "green",
  CHERRY_BLOSSOM = "cherry-blossom",
  AUTUMN = "autumn",
  SNOW = "snow",
  DARK_GREEN = "dark-green",
  DARK = "dark",
}

export enum PieceStandImageType {
  STANDARD = "standard",
  DARK_WOOD = "dark-wood",
  GREEN = "green",
  CHERRY_BLOSSOM = "cherry-blossom",
  AUTUMN = "autumn",
  SNOW = "snow",
  DARK_GREEN = "dark-green",
  DARK = "dark",
}

export enum PromotionSelectorStyle {
  HORIZONTAL = "horizontal",
  VERTICAL_PREFER_BOTTOM = "verticalPreferBottom",
  HORIZONTAL_PREFER_RIGHT = "horizontalPreferRight",
}

export enum BoardLabelType {
  NONE = "none",
  STANDARD = "standard",
}

export enum TabPaneType {
  SINGLE = "single",
  DOUBLE = "double",
  DOUBLE_V2 = "doubleV2",
}

export enum Tab {
  RECORD_INFO = "recordInfo",
  COMMENT = "comment",
  SEARCH = "search",
  PV = "pv",
  CHART = "chart",
  PERCENTAGE_CHART = "percentageChart",
  MONITOR = "monitor",
  INVISIBLE = "invisible", // Deprecated
  ANALYSIS_DB = "analysisDB",
}

export enum AnalysisDBSearchMode {
  NONE = "none",
  EXCEPT_GAMES = "exceptGames",
  ALWAYS = "always",
}

export enum TextDecodingRule {
  STRICT = "strict",
  AUTO_DETECT = "autoDetect",
}

export enum NodeCountFormat {
  PLAIN = "plain",
  COMMA_SEPARATED = "commaSeparated",
  COMPACT = "compact",
  JAPANESE = "japanese",
}

export enum EvaluationViewFrom {
  BLACK = "black",
  EACH = "each",
}

export enum ClockSoundTarget {
  ALL = "all",
  ONLY_USER = "onlyUser",
}

export enum RecordShortcutKeys {
  VERTICAL = "vertical",
  HORIZONTAL = "horizontal",
}

export enum FileQuickAction {
  PUZZLE = "puzzle",
  OPEN = "open",
  LOAD_FROM_SERVER = "loadFromServer",
  HISTORY = "history",
  ELAPSED_TIME_CHART = "elapsedTimeChart",
}

export function isFileQuickAction(value: unknown): value is FileQuickAction {
  return Object.values(FileQuickAction).includes(value as FileQuickAction);
}

export function normalizeFileQuickAction(value: unknown): FileQuickAction {
  return isFileQuickAction(value) ? value : FileQuickAction.PUZZLE;
}

export enum PositionImageStyle {
  BOOK = "book",
  GAME = "game",
}

export enum PositionImageTypeface {
  GOTHIC = "gothic",
  MINCHO = "mincho",
}

export enum PositionImageHandLabelType {
  PLAYER_NAME = "playerName",
  SENTE_GOTE = "senteGote",
  MOCHIGOMA = "mochigoma",
  TSUME_SHOGI = "tsumeShogi",
  NONE = "none",
}

export enum PositionImageFontWeight {
  W400 = "400",
  W400X = "400+",
  W700X = "700+",
}

export enum BranchListMode {
  SIBLING = "sibling",
  NEXT_MOVE = "nextMove",
}

export enum UIMode {
  AUTO = "auto",
  PC = "pc",
  MOBILE = "mobile",
}

export type AppSettings = {
  // Language
  language: Language;

  // Appearance
  thema: Thema;
  boardLayoutType: BoardLayoutType;
  pieceImage: PieceImageType;
  kingPieceType: KingPieceType;
  boardImage: BoardImageType;
  boardGridColor: string | null;
  pieceStandImage: PieceStandImageType;
  promotionSelectorStyle: PromotionSelectorStyle;
  enableTransparent: boolean;
  boardOpacity: number;
  pieceStandOpacity: number;
  recordOpacity: number;
  boardLabelType: BoardLabelType;

  // Sound
  pieceVolume: number;
  clockVolume: number;
  clockPitch: number;
  clockSoundTarget: ClockSoundTarget;

  // Shortcut
  recordShortcutKeys: RecordShortcutKeys;
  fileQuickAction: FileQuickAction;

  // Board View
  boardFlipping: boolean;
  enableDragAndDrop: boolean;
  enableVisionCameraAutoOpen: boolean;

  // Tab View
  tabPaneType: TabPaneType;
  tab: Tab;
  tab2: Tab;
  topPaneHeightPercentage: number;
  topPanePreviousHeightPercentage: number;
  bottomLeftPaneWidthPercentage: number;

  // Record File
  defaultRecordFileFormat: RecordFileFormat;
  textDecodingRule: TextDecodingRule;
  returnCode: string;
  recordFileNameTemplate: string;
  useCSAV3: boolean;
  useUTF8ForKifAndKi2: boolean;
  enableUSIFileStartpos: boolean;
  enableUSIFileResign: boolean;
  showPasteDialog: boolean;
  liveDuplicatePositionDetection: boolean;

  // Opening Book
  flippedBook: boolean;
  defaultBookFormat: BookFormat;

  // Engine
  engineTimeoutSeconds: number;
  nodeCountFormat: NodeCountFormat;
  researchMultiPV: number;
  researchChangeMultiPVFromPV: boolean;
  defaultResearchEngineURI: string; // Added

  // Evaluation
  hideEngineThinkingInHumanGames: boolean;
  evaluationViewFrom: EvaluationViewFrom;
  maxArrowsPerEngine: number;
  arrowScoreDiffRange: number;
  coefficientInSigmoid: number;
  badMoveLevelThreshold1: number;
  badMoveLevelThreshold2: number;
  badMoveLevelThreshold3: number;
  badMoveLevelThreshold4: number;
  maxPVTextLength: number;
  searchCommentFormat: SearchCommentFormat;

  // Record View
  showElapsedTimeInRecordView: boolean;
  showCommentInRecordView: boolean;
  branchListMode: BranchListMode;

  // Position Image
  positionImageStyle: PositionImageStyle;
  positionImageSize: number;
  positionImageTypeface: PositionImageTypeface;
  positionImageHandLabelType: PositionImageHandLabelType;
  useBookmarkAsPositionImageHeader: boolean;
  positionImageHeader: string;
  positionImageFontScale: number;
  positionImageFontWeight: PositionImageFontWeight;

  // Record Info View
  emptyRecordInfoVisibility: boolean;

  // Mobile
  showBookTableOnMobile: boolean;
  showSearchLogOnMobile: boolean;
  evaluationChartType: EvaluationChartType;

  // Analysis DB
  analysisDBSearchMode: AnalysisDBSearchMode;
  analysisDBMaxPVLength: number;

  uiMode: UIMode;
};

export type AppSettingsUpdate = Partial<AppSettings>;

export function buildUpdatedAppSettings(org: AppSettings, update: AppSettingsUpdate): AppSettings {
  const updated = {
    ...org,
    ...update,
  };
  updated.fileQuickAction = normalizeFileQuickAction(updated.fileQuickAction);

  // カラム構成に合わせて選択可能なタブを制限する。
  switch (updated.tabPaneType) {
    case TabPaneType.DOUBLE:
    case TabPaneType.DOUBLE_V2:
      switch (updated.tab) {
        case Tab.COMMENT:
          updated.tab = Tab.RECORD_INFO;
          break;
        case Tab.CHART:
        case Tab.PERCENTAGE_CHART:
          updated.tab = Tab.PV;
          break;
      }
      break;
  }
  switch (updated.tabPaneType) {
    case TabPaneType.DOUBLE_V2:
      switch (updated.tab2) {
        case Tab.COMMENT:
          updated.tab2 = Tab.CHART;
          break;
      }
      break;
  }

  // 以前のサイズ比率を記憶する。
  if (org.topPaneHeightPercentage !== 0 && org.topPaneHeightPercentage !== 100) {
    updated.topPanePreviousHeightPercentage = org.topPaneHeightPercentage;
  }

  return updated;
}

export function defaultAppSettings(opt?: { returnCode?: string }): AppSettings {
  return {
    language: Language.JA,
    thema: Thema.STANDARD,
    boardLayoutType: BoardLayoutType.STANDARD,
    pieceImage: PieceImageType.HITOMOJI_WOOD,
    kingPieceType: KingPieceType.GYOKU_AND_OSHO,
    boardImage: BoardImageType.LIGHT2,
    boardGridColor: null,
    pieceStandImage: PieceStandImageType.DARK_WOOD,
    promotionSelectorStyle: PromotionSelectorStyle.HORIZONTAL,
    enableTransparent: false,
    boardOpacity: 1.0,
    pieceStandOpacity: 1.0,
    recordOpacity: 1.0,
    boardLabelType: BoardLabelType.STANDARD,
    pieceVolume: 30,
    clockVolume: 30,
    clockPitch: 500,
    clockSoundTarget: ClockSoundTarget.ONLY_USER,
    recordShortcutKeys: RecordShortcutKeys.VERTICAL,
    fileQuickAction: FileQuickAction.PUZZLE,
    boardFlipping: false,
    enableDragAndDrop: true,
    enableVisionCameraAutoOpen: false,
    tabPaneType: TabPaneType.DOUBLE_V2,
    tab: Tab.RECORD_INFO,
    tab2: Tab.CHART,
    topPaneHeightPercentage: 60,
    topPanePreviousHeightPercentage: 60,
    bottomLeftPaneWidthPercentage: 60,
    defaultRecordFileFormat: RecordFileFormat.KIF,
    textDecodingRule: TextDecodingRule.AUTO_DETECT,
    returnCode: opt?.returnCode || "\r\n",
    recordFileNameTemplate: defaultRecordFileNameTemplate,
    useCSAV3: false,
    useUTF8ForKifAndKi2: false,
    enableUSIFileStartpos: true,
    enableUSIFileResign: false,
    showPasteDialog: true,
    liveDuplicatePositionDetection: true,
    flippedBook: true,
    defaultBookFormat: "yane2016",
    engineTimeoutSeconds: 10,
    nodeCountFormat: NodeCountFormat.COMMA_SEPARATED,
    researchMultiPV: 1,
    researchChangeMultiPVFromPV: true,
    defaultResearchEngineURI: "", // Added
    hideEngineThinkingInHumanGames: false,
    evaluationViewFrom: EvaluationViewFrom.BLACK,
    maxArrowsPerEngine: 3,
    arrowScoreDiffRange: 100,
    coefficientInSigmoid: 600,
    badMoveLevelThreshold1: 5,
    badMoveLevelThreshold2: 10,
    badMoveLevelThreshold3: 20,
    badMoveLevelThreshold4: 50,
    maxPVTextLength: 15,
    searchCommentFormat: SearchCommentFormat.SHOGIHOME,
    showElapsedTimeInRecordView: true,
    showCommentInRecordView: true,
    branchListMode: BranchListMode.SIBLING,
    positionImageStyle: PositionImageStyle.BOOK,
    positionImageSize: 500,
    positionImageTypeface: PositionImageTypeface.GOTHIC,
    positionImageHandLabelType: PositionImageHandLabelType.PLAYER_NAME,
    useBookmarkAsPositionImageHeader: false,
    positionImageHeader: "",
    positionImageFontScale: 1,
    positionImageFontWeight: PositionImageFontWeight.W400X,
    emptyRecordInfoVisibility: true,
    showBookTableOnMobile: false,
    showSearchLogOnMobile: false,
    evaluationChartType: EvaluationChartType.RAW,
    analysisDBSearchMode: AnalysisDBSearchMode.EXCEPT_GAMES,
    analysisDBMaxPVLength: 15,
    uiMode: UIMode.AUTO,
  };
}

export function normalizeAppSettings(
  settings: AppSettings,
  opt?: {
    returnCode?: string;
  },
): AppSettings {
  const defaults = defaultAppSettings(opt);
  const result: AppSettings & { autoSaveDirectory?: unknown } = {
    ...defaults,
    ...settings,
  };
  // Game settings migration reads this legacy key directly from browser storage.
  delete result.autoSaveDirectory;
  result.fileQuickAction = normalizeFileQuickAction(result.fileQuickAction);
  result.hideEngineThinkingInHumanGames = settings.hideEngineThinkingInHumanGames === true;
  // 旧バージョンでは盤画像に合わせて自動で駒台の色が選ばれていた。
  if (!settings.pieceStandImage) {
    switch (settings.boardImage) {
      default:
        result.pieceStandImage = PieceStandImageType.STANDARD;
        break;
      case BoardImageType.DARK:
        result.pieceStandImage = PieceStandImageType.DARK;
        break;
      case BoardImageType.GREEN:
        result.pieceStandImage = PieceStandImageType.GREEN;
        break;
      case BoardImageType.CHERRY_BLOSSOM:
        result.pieceStandImage = PieceStandImageType.CHERRY_BLOSSOM;
        break;
    }
  }
  // Retired custom images and unsupported values fall back to bundled assets.
  if (!Object.values(PieceImageType).includes(result.pieceImage)) {
    result.pieceImage = defaults.pieceImage;
  }
  if (!Object.values(BoardImageType).includes(result.boardImage)) {
    result.boardImage = defaults.boardImage;
  }
  if (!Object.values(PieceStandImageType).includes(result.pieceStandImage)) {
    result.pieceStandImage = defaults.pieceStandImage;
  }
  // 旧バージョンではタブの最小化を Tab.INDISIBLE で表していたが廃止した。
  if (result.tab === Tab.INVISIBLE) {
    result.tab = Tab.RECORD_INFO;
  }
  // 旧バージョンと行き来すると DOUBLE_V2 のまま Tab.COMMENT が選択された状態が発生しうる。
  if (result.tabPaneType === TabPaneType.DOUBLE_V2 && result.tab2 === Tab.COMMENT) {
    result.tab2 = Tab.CHART;
  }
  if (!settings.analysisDBSearchMode) {
    result.analysisDBSearchMode = AnalysisDBSearchMode.EXCEPT_GAMES;
  }
  // Fall back when persisted settings contain an unsupported format.
  if (!isBookFormat(result.defaultBookFormat)) {
    result.defaultBookFormat = "yane2016";
  }
  if (settings.enableVisionCameraAutoOpen === undefined) {
    result.enableVisionCameraAutoOpen = false;
  }
  // 旧バージョンではフォントの太さは設定項目になく、明朝体とゴシック体で違っていた。
  if (!settings.positionImageFontWeight) {
    switch (settings.positionImageTypeface) {
      default:
        result.positionImageFontWeight = PositionImageFontWeight.W400X;
        break;
      case PositionImageTypeface.MINCHO:
        result.positionImageFontWeight = PositionImageFontWeight.W700X;
        break;
    }
  }
  return result;
}

export function validateAppSettings(settings: AppSettings): Error | undefined {
  if (settings.pieceVolume < 0 || settings.pieceVolume > 100) {
    return new Error(t.pieceSoundVolumeMustBe0To100Percent);
  }
  if (settings.clockVolume < 0 || settings.clockVolume > 100) {
    return new Error(t.clockSoundVolumeMustBe0To100Percent);
  }
  if (settings.clockPitch < 220 || settings.clockPitch > 880) {
    return new Error(t.clockSoundPitchMustBe220To880Hz);
  }
  if (settings.engineTimeoutSeconds < 1 || settings.engineTimeoutSeconds > 300) {
    return new Error(t.engineTimeoutMustBe1To300Seconds);
  }
  if (settings.researchMultiPV < 1 || settings.researchMultiPV > 10) {
    return new Error(t.multiPVMustBe1To10);
  }
  if (settings.coefficientInSigmoid <= 0) {
    return new Error(t.coefficientInSigmoidMustBeGreaterThan0);
  }
  if (settings.badMoveLevelThreshold1 < 1 || settings.badMoveLevelThreshold1 > 100) {
    return new Error(t.inaccuracyThresholdMustBe1To100Percent);
  }
  if (settings.badMoveLevelThreshold2 < 1 || settings.badMoveLevelThreshold2 > 100) {
    return new Error(t.dubiousThresholdMustBe1To100Percent);
  }
  if (settings.badMoveLevelThreshold3 < 1 || settings.badMoveLevelThreshold3 > 100) {
    return new Error(t.mistakeThresholdMustBe1To100Percent);
  }
  if (settings.badMoveLevelThreshold4 < 1 || settings.badMoveLevelThreshold4 > 100) {
    return new Error(t.blunderThresholdMustBe1To100Percent);
  }
  if (settings.badMoveLevelThreshold1 >= settings.badMoveLevelThreshold2) {
    return new Error(t.inaccuracyThresholdMustBeLessThanDubiousThreshold);
  }
  if (settings.badMoveLevelThreshold2 >= settings.badMoveLevelThreshold3) {
    return new Error(t.dubiousThresholdMustBeLessThanMistakeThreshold);
  }
  if (settings.badMoveLevelThreshold3 >= settings.badMoveLevelThreshold4) {
    return new Error(t.mistakeThresholdMustBeLessThanBlunderThreshold);
  }
}

export function getPieceImageURLTemplate(settings: AppSettings): string {
  switch (settings.pieceImage) {
    case PieceImageType.HITOMOJI_WOOD:
      return "./piece/hitomoji_wood/${piece}.png";
    case PieceImageType.HITOMOJI_DARK:
      return "./piece/hitomoji_dark/${piece}.png";
    case PieceImageType.HITOMOJI_GOTHIC:
      return "./piece/hitomoji_gothic/${piece}.png";
    case PieceImageType.HITOMOJI_GOTHIC_DARK:
      return "./piece/hitomoji_gothic_dark/${piece}.png";
    case PieceImageType.FUTAMOJI:
      return "./piece/futamoji/${piece}.png";
  }
  return "./piece/hitomoji/${piece}.png";
}
