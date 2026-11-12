import {
  normalizeAppSettings,
  getPieceImageURLTemplate,
  defaultAppSettings,
  PieceImageType,
  BoardImageType,
  PieceStandImageType,
  validateAppSettings,
  AnalysisDBSearchMode,
  FileQuickAction,
  buildUpdatedAppSettings,
  Tab,
  TabPaneType,
} from "@/common/settings/app";
import { BookFormat } from "@/common/book";

describe("settings/app", () => {
  it("normalize", () => {
    const result = normalizeAppSettings(defaultAppSettings(), {
      returnCode: "\r\n",
    });
    expect(result).toStrictEqual(defaultAppSettings());
  });

  it("defaults and normalizes the evaluation chart range", () => {
    const defaults = defaultAppSettings();
    expect(defaults.evaluationChartRange).toBe("2000");
    for (const value of ["1000", "1500", "2000"] as const) {
      expect(
        normalizeAppSettings({ ...defaults, evaluationChartRange: value }).evaluationChartRange,
      ).toBe(value);
      expect(
        buildUpdatedAppSettings(defaults, { evaluationChartRange: value }).evaluationChartRange,
      ).toBe(value);
    }
    for (const value of [undefined, null, 1000, "4000", ""]) {
      const invalid = value as typeof defaults.evaluationChartRange;
      expect(
        normalizeAppSettings({ ...defaults, evaluationChartRange: invalid }).evaluationChartRange,
      ).toBe("2000");
      expect(
        buildUpdatedAppSettings(defaults, { evaluationChartRange: invalid }).evaluationChartRange,
      ).toBe("2000");
    }
  });

  it("does not include the retired auto-save directory in app defaults", () => {
    expect(defaultAppSettings()).not.toHaveProperty("autoSaveDirectory");
  });

  it.each(
    ["", "server://games///", 1, false, null, [], {}].map((autoSaveDirectory) => ({
      autoSaveDirectory,
    })),
  )(
    "drops the legacy app destination $autoSaveDirectory without mutating the input",
    ({ autoSaveDirectory }) => {
      const settings = { ...defaultAppSettings(), autoSaveDirectory, pieceVolume: 42 };
      const normalized = normalizeAppSettings(settings);
      expect(normalized).not.toHaveProperty("autoSaveDirectory");
      expect(normalized.pieceVolume).toBe(42);
      expect(normalizeAppSettings(normalized)).toEqual(normalized);
      expect(settings.autoSaveDirectory).toBe(autoSaveDirectory);
    },
  );

  it("normalize/analysisDBSearchMode", () => {
    const result = normalizeAppSettings({
      ...defaultAppSettings(),
      analysisDBSearchMode: undefined as unknown as AnalysisDBSearchMode,
    });
    expect(result.analysisDBSearchMode).toBe(AnalysisDBSearchMode.EXCEPT_GAMES);
  });

  it("normalize/enableVisionCameraAutoOpen", () => {
    const result = normalizeAppSettings({
      ...defaultAppSettings(),
      enableVisionCameraAutoOpen: undefined as unknown as boolean,
    });
    expect(result.enableVisionCameraAutoOpen).toBe(false);
  });

  it.each([undefined, false, true, "true", null])(
    "normalizes the opt-in thinking visibility setting %s",
    (value) => {
      expect(defaultAppSettings().hideEngineThinkingInHumanGames).toBe(false);
      const settings = {
        ...defaultAppSettings(),
        hideEngineThinkingInHumanGames: value as boolean,
      };
      expect(normalizeAppSettings(settings).hideEngineThinkingInHumanGames).toBe(value === true);
    },
  );

  it("normalize/defaultBookFormat", () => {
    expect(defaultAppSettings().defaultBookFormat).toBe("yane2016");
    const result = normalizeAppSettings({
      ...defaultAppSettings(),
      defaultBookFormat: "invalid" as unknown as BookFormat,
    });
    expect(result.defaultBookFormat).toBe("yane2016");
  });

  it("defaults the quick action for old and invalid settings", () => {
    const settings = defaultAppSettings();
    expect(settings.fileQuickAction).toBe(FileQuickAction.PUZZLE);
    expect(
      normalizeAppSettings({
        ...settings,
        fileQuickAction: undefined as unknown as FileQuickAction,
      }).fileQuickAction,
    ).toBe(FileQuickAction.PUZZLE);
    expect(
      normalizeAppSettings({ ...settings, fileQuickAction: "unknown" as FileQuickAction })
        .fileQuickAction,
    ).toBe(FileQuickAction.PUZZLE);
    expect(
      buildUpdatedAppSettings(settings, { fileQuickAction: "unknown" as FileQuickAction })
        .fileQuickAction,
    ).toBe(FileQuickAction.PUZZLE);
    expect(
      buildUpdatedAppSettings(settings, { fileQuickAction: FileQuickAction.LOAD_FROM_SERVER })
        .fileQuickAction,
    ).toBe(FileQuickAction.LOAD_FROM_SERVER);
    expect(
      buildUpdatedAppSettings(settings, { fileQuickAction: FileQuickAction.JOBS }).fileQuickAction,
    ).toBe(FileQuickAction.JOBS);
    expect(
      normalizeAppSettings({ ...settings, fileQuickAction: FileQuickAction.JOBS }).fileQuickAction,
    ).toBe(FileQuickAction.JOBS);
  });

  it("pieceImageBaseURL", () => {
    expect(
      getPieceImageURLTemplate({
        ...defaultAppSettings(),
        pieceImage: PieceImageType.HITOMOJI,
      }),
    ).toBe("./piece/hitomoji/${piece}.png");

    expect(
      getPieceImageURLTemplate({
        ...defaultAppSettings(),
        pieceImage: PieceImageType.HITOMOJI_GOTHIC,
      }),
    ).toBe("./piece/hitomoji_gothic/${piece}.png");

    expect(
      getPieceImageURLTemplate({
        ...defaultAppSettings(),
        pieceImage: PieceImageType.HITOMOJI_DARK,
      }),
    ).toBe("./piece/hitomoji_dark/${piece}.png");

    expect(
      getPieceImageURLTemplate({
        ...defaultAppSettings(),
        pieceImage: PieceImageType.HITOMOJI_GOTHIC_DARK,
      }),
    ).toBe("./piece/hitomoji_gothic_dark/${piece}.png");

    expect(
      getPieceImageURLTemplate({
        ...defaultAppSettings(),
        pieceImage: PieceImageType.FUTAMOJI,
      }),
    ).toBe("./piece/futamoji/${piece}.png");
  });

  it.each(["custom-image", "unknown"])(
    "replaces unsupported image selection %s with bundled defaults",
    (value) => {
      const settings = {
        ...defaultAppSettings(),
        pieceImage: value as PieceImageType,
        boardImage: value as BoardImageType,
        pieceStandImage: value as PieceStandImageType,
      };
      const result = normalizeAppSettings(settings);
      const defaults = defaultAppSettings();
      expect(result).toMatchObject({
        pieceImage: defaults.pieceImage,
        boardImage: defaults.boardImage,
        pieceStandImage: defaults.pieceStandImage,
      });
      expect(validateAppSettings(result)).toBeUndefined();
      expect(settings.pieceImage).toBe(value);
    },
  );

  it("preserves selected bundled images", () => {
    const settings = {
      ...defaultAppSettings(),
      pieceImage: PieceImageType.FUTAMOJI,
      boardImage: BoardImageType.DARK,
      pieceStandImage: PieceStandImageType.GREEN,
    };
    expect(normalizeAppSettings(settings)).toEqual(settings);
  });

  describe("tab pane normalization", () => {
    it("defaults an unknown layout before normalizing its tabs", () => {
      const result = normalizeAppSettings({
        ...defaultAppSettings(),
        tabPaneType: "unknown" as TabPaneType,
        tab: Tab.COMMENT,
        tab2: Tab.COMMENT,
      });
      expect(result.tabPaneType).toBe(defaultAppSettings().tabPaneType);
      expect(result.tab).toBe(Tab.RECORD_INFO);
      expect(result.tab2).toBe(Tab.CHART);
      expect(normalizeAppSettings(result)).toEqual(result);
    });

    it.each([
      [TabPaneType.SINGLE, Tab.COMMENT, Tab.COMMENT],
      [TabPaneType.DOUBLE, Tab.COMMENT, Tab.RECORD_INFO],
      [TabPaneType.DOUBLE, Tab.CHART, Tab.PV],
      [TabPaneType.DOUBLE, Tab.ANALYSIS_DB, Tab.ANALYSIS_DB],
      [TabPaneType.DOUBLE_V2, Tab.COMMENT, Tab.RECORD_INFO],
      [TabPaneType.DOUBLE_V2, Tab.PERCENTAGE_CHART, Tab.PV],
      [TabPaneType.DOUBLE_V2, Tab.ANALYSIS_DB, Tab.ANALYSIS_DB],
      [TabPaneType.GRID_2X2, Tab.COMMENT, Tab.RECORD_INFO],
      [TabPaneType.GRID_2X2, Tab.CHART, Tab.PV],
      [TabPaneType.GRID_2X2, Tab.PERCENTAGE_CHART, Tab.PV],
      [TabPaneType.GRID_2X2, Tab.ANALYSIS_DB, Tab.PV],
      [TabPaneType.GRID_2X2, Tab.SEARCH, Tab.SEARCH],
    ])("normalizes tab for %s: %s -> %s", (tabPaneType, tab, expected) => {
      const updated = buildUpdatedAppSettings(defaultAppSettings(), { tabPaneType, tab });
      const normalized = normalizeAppSettings({ ...defaultAppSettings(), tabPaneType, tab });
      expect(updated.tab).toBe(expected);
      expect(normalized.tab).toBe(expected);
      expect(normalizeAppSettings(normalized)).toEqual(normalized);
    });

    it.each([
      [TabPaneType.DOUBLE, Tab.COMMENT, Tab.COMMENT],
      [TabPaneType.DOUBLE, Tab.PERCENTAGE_CHART, Tab.PERCENTAGE_CHART],
      [TabPaneType.DOUBLE_V2, Tab.COMMENT, Tab.CHART],
      [TabPaneType.DOUBLE_V2, Tab.PERCENTAGE_CHART, Tab.PERCENTAGE_CHART],
      [TabPaneType.GRID_2X2, Tab.COMMENT, Tab.CHART],
      [TabPaneType.GRID_2X2, Tab.PERCENTAGE_CHART, Tab.PERCENTAGE_CHART],
    ])("normalizes tab2 for %s: %s -> %s", (tabPaneType, tab2, expected) => {
      const updated = buildUpdatedAppSettings(defaultAppSettings(), { tabPaneType, tab2 });
      const normalized = normalizeAppSettings({ ...defaultAppSettings(), tabPaneType, tab2 });
      expect(updated.tab2).toBe(expected);
      expect(normalized.tab2).toBe(expected);
      expect(normalizeAppSettings(normalized)).toEqual(normalized);
    });
  });
});
