import {
  ResearchSettings,
  defaultResearchSettings,
  normalizeResearchSettings,
  validateResearchSettings,
} from "@/common/settings/research";
import { emptyUSIEngine } from "@/common/settings/usi";
import { t } from "@/common/i18n";
import { MIN_MULTIPV, MAX_MULTIPV } from "@/common/engine/relay_protocol";

describe("settings/research", () => {
  it.each([1, 3, 10])("accepts explicit MultiPV %i", (multiPV) => {
    expect(
      validateResearchSettings({
        ...defaultResearchSettings(),
        usi: { ...emptyUSIEngine(), uri: "lan-engine:test" },
        overrideMultiPV: true,
        multiPV,
      }),
    ).toBeUndefined();
  });

  it.each([0, -1, 1.5, 11, NaN, Infinity])("validates MultiPV %s only when enabled", (multiPV) => {
    const settings = {
      ...defaultResearchSettings(),
      usi: { ...emptyUSIEngine(), uri: "lan-engine:test" },
      multiPV,
    };
    expect(validateResearchSettings(settings)).toBeUndefined();
    expect(validateResearchSettings({ ...settings, overrideMultiPV: true })?.message).toBe(
      t.multiPVInvalid(MIN_MULTIPV, MAX_MULTIPV),
    );
  });

  it("normalize", () => {
    const settings: ResearchSettings = {
      usi: {
        uri: "lan-engine:test-engine",
        name: "Test Engine",
      },
      secondaries: [],
      enableMaxSeconds: false,
      maxSeconds: 10,
      overrideMultiPV: false,
      multiPV: 1,
    };
    const result = normalizeResearchSettings(settings);
    expect(result).toStrictEqual(settings);
  });

  it("validate/ok", () => {
    const settings: ResearchSettings = {
      usi: {
        uri: "lan-engine:test-engine",
        name: "Test Engine",
      },
      secondaries: [],
      enableMaxSeconds: false,
      maxSeconds: 10,
      overrideMultiPV: false,
      multiPV: 1,
    };
    expect(validateResearchSettings(settings)).toBeUndefined();
  });

  it("validate/invalidEngine", () => {
    const settings: ResearchSettings = {
      secondaries: [],
      enableMaxSeconds: false,
      maxSeconds: 10,
      overrideMultiPV: false,
      multiPV: 1,
    };
    expect(validateResearchSettings(settings)).toBeInstanceOf(Error);
  });

  it("validate/invalidSecondaryEngine", () => {
    const settings: ResearchSettings = {
      usi: {
        uri: "lan-engine:test-engine",
        name: "Test Engine",
      },
      secondaries: [{}],
      enableMaxSeconds: false,
      maxSeconds: 10,
      overrideMultiPV: false,
      multiPV: 1,
    };
    expect(validateResearchSettings(settings)).toBeInstanceOf(Error);
  });
});
