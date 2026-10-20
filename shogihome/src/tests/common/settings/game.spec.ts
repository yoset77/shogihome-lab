import {
  defaultGameSettings,
  GameSettings,
  JishogiRule,
  normalizeGameSettings,
  validateGameSettings,
} from "@/common/settings/game";
import { InitialPositionType } from "tsshogi";
import * as uri from "@/common/uri";
import { BookMoveSelectionRule } from "@/common/settings/usi";

describe("settings/game", () => {
  it("defaults both players to humans", () => {
    const settings = defaultGameSettings();
    expect(settings.black.uri).toBe(uri.ES_HUMAN);
    expect(settings.white.uri).toBe(uri.ES_HUMAN);
  });

  it.each(["static_rook/v1", "ranging_rook/v1", "random"])(
    "falls back to humans for retired built-in AI settings: %s",
    (engine) => {
      const settings = defaultGameSettings();
      const legacy = { name: "Old AI", uri: `es://basic-engine/${engine}` };
      const result = normalizeGameSettings({ ...settings, black: legacy, white: legacy });
      expect(result.black).toEqual(settings.black);
      expect(result.white).toEqual(settings.white);
      expect(legacy.uri).toBe(`es://basic-engine/${engine}`);
    },
  );

  it("normalize", () => {
    const settings: GameSettings = {
      black: {
        name: "先手番",
        uri: uri.ES_HUMAN,
      },
      white: {
        name: "後手番",
        uri: "lan-engine:test-engine",
        usi: {
          uri: "lan-engine:test-engine",
          name: "Test Engine",
        },
      },
      timeLimit: {
        timeSeconds: 1234,
        byoyomi: 10,
        increment: 0,
      },
      startPosition: InitialPositionType.HANDICAP_2PIECES,
      startPositionListFile: "",
      startPositionListOrder: "sequential",
      enableEngineTimeout: true,
      humanIsFront: false,
      enableComment: false,
      enableAutoSave: false,
      repeat: 3,
      swapPlayers: false,
      maxMoves: 80,
      jishogiRule: JishogiRule.NONE,
    };
    const result = normalizeGameSettings(settings);
    expect(result).toStrictEqual(settings);

    const legacy = {
      ...settings,
      white: {
        ...settings.white,
        usi: {
          ...settings.white.usi,
          extraBook: {
            enabled: true,
            filePath: "book.db",
            considerBookMoveCount: false,
          },
        },
      },
    } as unknown as GameSettings;
    expect(normalizeGameSettings(legacy).white.usi?.extraBook).toMatchObject({
      enabled: true,
      filePath: "book.db",
      moveSelectionRule: BookMoveSelectionRule.UNIFORM,
      scoreTemperature: 50,
    });
  });

  it("validateGameSettings/startPositionListPly-valid", () => {
    const settings: GameSettings = {
      ...defaultGameSettings(),
      startPositionListPly: undefined,
    };
    expect(validateGameSettings(settings)).toBeUndefined();
    expect(validateGameSettings({ ...settings, startPositionListPly: 1 })).toBeUndefined();
    expect(validateGameSettings({ ...settings, startPositionListPly: 100 })).toBeUndefined();
  });

  it("validateGameSettings/startPositionListPly-invalid", () => {
    const settings = defaultGameSettings();
    const check = (ply: unknown) =>
      validateGameSettings({
        ...settings,
        startPositionListPly: ply as number,
      });
    expect(check(0)?.message).toBe("Start position list ply must be a positive integer.");
    expect(check(-1)?.message).toBe("Start position list ply must be a positive integer.");
    expect(check(0.5)?.message).toBe("Start position list ply must be a positive integer.");
    expect(check("")?.message).toBe("Start position list ply must be a positive integer.");
  });
});
