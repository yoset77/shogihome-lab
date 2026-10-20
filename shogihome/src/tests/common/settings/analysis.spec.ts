import {
  AnalysisSettings,
  defaultAnalysisSettings,
  normalizeAnalysisSettings,
  validateAnalysisSettings,
} from "@/common/settings/analysis";
import { CommentBehavior } from "@/common/settings/comment";
import { t } from "@/common/i18n";
import { MIN_MULTIPV, MAX_MULTIPV } from "@/common/engine/relay_protocol";

describe("settings/analysis", () => {
  it("defaults legacy settings to engine-controlled MultiPV", () => {
    const settings = { descending: true, perMoveCriteria: { maxSeconds: 7 } };
    expect(normalizeAnalysisSettings(settings)).toMatchObject({
      ...settings,
      overrideMultiPV: false,
      multiPV: 1,
    });
  });

  it.each([1, 3, 10])("accepts explicit MultiPV %i", (multiPV) => {
    expect(
      validateAnalysisSettings({ ...defaultAnalysisSettings(), overrideMultiPV: true, multiPV }),
    ).toBeUndefined();
  });

  it.each([0, -1, 1.5, 11, NaN, Infinity])("validates MultiPV %s only when enabled", (multiPV) => {
    const settings = { ...defaultAnalysisSettings(), multiPV };
    expect(validateAnalysisSettings(settings)).toBeUndefined();
    expect(validateAnalysisSettings({ ...settings, overrideMultiPV: true })?.message).toBe(
      t.multiPVInvalid(MIN_MULTIPV, MAX_MULTIPV),
    );
  });

  it("normalize", () => {
    const settings: AnalysisSettings = {
      overrideMultiPV: true,
      multiPV: 3,
      usi: {
        uri: "lan-engine:test-engine",
        name: "Test Engine",
      },
      startCriteria: {
        enableNumber: true,
        number: 10,
      },
      endCriteria: {
        enableNumber: true,
        number: 20,
      },
      perMoveCriteria: {
        maxSeconds: 10,
      },
      descending: true,
      commentBehavior: CommentBehavior.APPEND,
    };
    const result = normalizeAnalysisSettings(settings);
    expect(result).toEqual(settings);
  });

  it("validate", () => {
    expect(
      validateAnalysisSettings({
        ...defaultAnalysisSettings(),
        startCriteria: { enableNumber: false, number: 0 },
        endCriteria: { enableNumber: false, number: 0 },
        perMoveCriteria: { maxSeconds: 0 },
        descending: false,
        commentBehavior: CommentBehavior.INSERT,
      }),
    ).toBeUndefined();

    expect(
      validateAnalysisSettings({
        ...defaultAnalysisSettings(),
        startCriteria: { enableNumber: true, number: 30 },
        endCriteria: { enableNumber: true, number: 120 },
        perMoveCriteria: { maxSeconds: 0 },
        descending: true,
        commentBehavior: CommentBehavior.INSERT,
      }),
    ).toBeUndefined();

    expect(
      validateAnalysisSettings({
        ...defaultAnalysisSettings(),
        startCriteria: { enableNumber: true, number: 30 },
        endCriteria: { enableNumber: true, number: 30 },
        perMoveCriteria: { maxSeconds: 0 },
        descending: true,
        commentBehavior: CommentBehavior.INSERT,
      }),
    ).toBeUndefined();

    expect(
      validateAnalysisSettings({
        ...defaultAnalysisSettings(),
        startCriteria: { enableNumber: true, number: 0 },
        endCriteria: { enableNumber: false, number: 0 },
        perMoveCriteria: { maxSeconds: 0 },
        descending: true,
        commentBehavior: CommentBehavior.INSERT,
      }),
    ).toBeInstanceOf(Error);

    expect(
      validateAnalysisSettings({
        ...defaultAnalysisSettings(),
        startCriteria: { enableNumber: false, number: 0 },
        endCriteria: { enableNumber: true, number: 0 },
        perMoveCriteria: { maxSeconds: 0 },
        descending: true,
        commentBehavior: CommentBehavior.INSERT,
      }),
    ).toBeInstanceOf(Error);

    expect(
      validateAnalysisSettings({
        ...defaultAnalysisSettings(),
        startCriteria: { enableNumber: true, number: 30 },
        endCriteria: { enableNumber: true, number: 29 },
        perMoveCriteria: { maxSeconds: 0 },
        descending: true,
        commentBehavior: CommentBehavior.INSERT,
      }),
    ).toBeInstanceOf(Error);

    expect(
      validateAnalysisSettings({
        ...defaultAnalysisSettings(),
        startCriteria: { enableNumber: true, number: 30 },
        endCriteria: { enableNumber: true, number: 120 },
        perMoveCriteria: { maxSeconds: -1 },
        descending: true,
        commentBehavior: CommentBehavior.INSERT,
      }),
    ).toBeInstanceOf(Error);
  });
});
