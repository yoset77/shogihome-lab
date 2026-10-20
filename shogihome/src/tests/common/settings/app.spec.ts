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
} from "@/common/settings/app";
import { BookFormat } from "@/common/book";

describe("settings/app", () => {
  it("normalize", () => {
    const result = normalizeAppSettings(defaultAppSettings(), {
      returnCode: "\r\n",
      autoSaveDirectory: "/tmp",
    });
    expect(result).toStrictEqual(defaultAppSettings());
  });

  it.each([
    ["", ""],
    ["server://", "server://"],
    ["server:///", "server://"],
    ["server://games", "server://games"],
    ["server://games/", "server://games"],
    ["server://games///", "server://games"],
    ["server://games\\", "server://games"],
    ["games/", "games"],
    ["/tmp/games/", "/tmp/games"],
    ["C:\\games\\", "C:\\games"],
  ])("normalizes auto-save directory %s without changing its URI prefix", (directory, expected) => {
    const settings = { ...defaultAppSettings(), autoSaveDirectory: directory };
    const normalized = normalizeAppSettings(settings);
    expect(normalized.autoSaveDirectory).toBe(expected);
    expect(normalizeAppSettings(normalized)).toEqual(normalized);
    expect(settings.autoSaveDirectory).toBe(directory);
  });

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
});
