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
  it("normalize", () => {
    const settings: GameSettings = {
      black: {
        name: "先手番",
        uri: uri.ES_HUMAN,
      },
      white: {
        name: "後手番",
        uri: uri.ES_USI_ENGINE_PREFIX + "test-engine",
        usi: {
          uri: uri.ES_USI_ENGINE_PREFIX + "test-engine",
          name: "Test Engine",
          defaultName: "test engine",
          author: "test author",
          path: "/path/to/test-engine",
          options: {
            USI_Hash: { name: "USI_Hash", type: "spin", order: 1 },
          },
          labels: {},
          enableEarlyPonder: false,
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
