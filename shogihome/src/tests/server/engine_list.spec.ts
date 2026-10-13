import { afterEach, describe, expect, it } from "vitest";
import { parseEngineListPayload, toEngineConfig } from "@/server/engine/list";
import { resourceRegistry } from "@/server/engine/resources";

afterEach(() => resourceRegistry.resetForTest());

describe("engine list validation", () => {
  it("should accept well-formed engine configs", () => {
    expect(
      toEngineConfig({
        id: "engine-1",
        name: "Engine 1",
        type: ["game", "research"],
        skipAnalysisDB: true,
        analysisDBGroupId: "group-1",
        analysisDBGroupName: "Group 1",
        options: { Threads: 4 },
        resource: { groupId: "local", autoThreads: true },
      }),
    ).toEqual({
      id: "engine-1",
      name: "Engine 1",
      type: ["game", "research"],
      skipAnalysisDB: true,
      analysisDBGroupId: "group-1",
      analysisDBGroupName: "Group 1",
      threads: 4,
      resource: { groupId: "local", autoThreads: true },
    });
  });

  it("should reject malformed engine configs from wrapper JSON", () => {
    expect(toEngineConfig({ id: { nested: true }, name: "bad" })).toBeNull();
    expect(toEngineConfig({ id: "engine-1", name: 123 })).toBeNull();
    expect(toEngineConfig(null)).toBeNull();
    // Invalid resource settings are dropped silently like other optional fields.
    expect(toEngineConfig({ id: "e", name: "E", resource: { cost: -1 } })).toEqual({
      id: "e",
      name: "E",
    });
  });

  describe("list payload parsing", () => {
    it("parses a legacy array payload without resource settings", () => {
      const payload = parseEngineListPayload([{ id: "engine-1", name: "E1", type: "game" }]);
      expect(payload?.configs).toEqual([{ id: "engine-1", name: "E1", type: "game" }]);
      expect(payload?.resourceSettings).toBeUndefined();
    });

    it("parses a v2 document payload and updates the resource registry", () => {
      const payload = parseEngineListPayload({
        resources: {
          enabled: true,
          groups: [{ id: "local", name: "Local CPU", budget: 16 }],
        },
        engines: [
          {
            id: "engine-1",
            name: "E1",
            type: "research",
            options: { Threads: 4 },
            resource: { groupId: "local" },
          },
        ],
      });
      expect(payload?.configs).toHaveLength(1);
      expect(payload?.configs[0].threads).toBe(4);
      // The fetch path applies the settings to the registry.
      resourceRegistry.update(payload?.resourceSettings);
      expect(resourceRegistry.isEnabled()).toBe(true);
      expect(
        resourceRegistry.acquire({
          groupId: "local",
          cost: 4,
        }),
      ).toBeDefined();
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
      resourceRegistry.resetForTest();
    });

    it.each([undefined, 42, { engines: "nope" }, { resources: { groups: [{}] }, engines: [] }])(
      "rejects invalid payload %j",
      (value) => {
        expect(parseEngineListPayload(value)).toBeNull();
      },
    );
  });
});
