import {
  BookMoveSelectionRule,
  DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE,
  emptyUSIEngineExtraBookConfig,
  normalizeUSIEngine,
  normalizeUSIEngineExtraBookConfig,
} from "@/common/settings/usi";

describe("settings/usi", () => {
  it("preserves the default external book settings", () => {
    expect(DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE).toBe(50);
    expect(normalizeUSIEngineExtraBookConfig()).toEqual(emptyUSIEngineExtraBookConfig());
  });

  it.each([true, false])(
    "normalizes the legacy book count preference %s",
    (considerBookMoveCount) => {
      const result = normalizeUSIEngineExtraBookConfig({
        enabled: true,
        filePath: "server://book.db",
        considerBookMoveCount,
      });
      expect(result).toMatchObject({
        enabled: true,
        filePath: "server://book.db",
        moveSelectionRule: considerBookMoveCount
          ? BookMoveSelectionRule.WEIGHTED_BY_COUNT
          : BookMoveSelectionRule.UNIFORM,
        scoreTemperature: 50,
      });
      expect(result).not.toHaveProperty("considerBookMoveCount");
    },
  );

  it("preserves explicit book selection settings", () => {
    expect(
      normalizeUSIEngineExtraBookConfig({
        moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_SCORE,
        scoreTemperature: 75,
        maxMoves: 20,
      }),
    ).toMatchObject({
      moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_SCORE,
      scoreTemperature: 75,
      maxMoves: 20,
    });
  });

  it("normalizes invalid book preferences", () => {
    expect(
      normalizeUSIEngineExtraBookConfig({ moveSelectionRule: "invalid", scoreTemperature: 0 }),
    ).toMatchObject({
      moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_COUNT,
      scoreTemperature: 50,
    });
  });

  it("normalizes a wrapper-managed engine reference without changing its input", () => {
    const engine = {
      uri: "lan-engine:test",
      name: "Test",
      extraBook: { enabled: true, filePath: "server://book.db" },
    };
    expect(normalizeUSIEngine(engine as never)).toEqual({
      uri: engine.uri,
      name: engine.name,
      extraBook: { ...emptyUSIEngineExtraBookConfig(), ...engine.extraBook },
    });
    expect(engine.extraBook).toEqual({ enabled: true, filePath: "server://book.db" });
  });
});
