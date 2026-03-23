import {
  normalizeAppSettings,
  getPieceImageURLTemplate,
  defaultAppSettings,
  PieceImageType,
  AnalysisDBSearchMode,
} from "@/common/settings/app.js";

describe("settings/app", () => {
  it("normalize", () => {
    const result = normalizeAppSettings(defaultAppSettings(), {
      returnCode: "\r\n",
      autoSaveDirectory: "/tmp",
    });
    expect(result).toStrictEqual(defaultAppSettings());
  });

  it("normalize/analysisDBSearchMode", () => {
    const result = normalizeAppSettings({
      ...defaultAppSettings(),
      analysisDBSearchMode: undefined as unknown as AnalysisDBSearchMode,
    });
    expect(result.analysisDBSearchMode).toBe(AnalysisDBSearchMode.EXCEPT_GAMES);
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
        pieceImage: PieceImageType.CUSTOM_IMAGE,
        pieceImageFileURL: "/home/user/pictures/piece.png",
        croppedPieceImageBaseURL: "file:///home/user/.cache/piece",
      }),
    ).toBe("file:///home/user/.cache/piece/${piece}.png");

    expect(
      getPieceImageURLTemplate({
        ...defaultAppSettings(),
        pieceImage: PieceImageType.CUSTOM_IMAGE,
        pieceImageFileURL: "/home/user/pictures/piece.png",
        croppedPieceImageBaseURL: "file:///home/user/.cache/piece",
        croppedPieceImageQuery: "updated=12345",
      }),
    ).toBe("file:///home/user/.cache/piece/${piece}.png?updated=12345");
  });
});
