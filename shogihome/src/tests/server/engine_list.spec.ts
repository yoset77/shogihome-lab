import { describe, expect, it } from "vitest";
import { toEngineConfig } from "@/server/engine/list";

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
      }),
    ).toEqual({
      id: "engine-1",
      name: "Engine 1",
      type: ["game", "research"],
      skipAnalysisDB: true,
      analysisDBGroupId: "group-1",
      analysisDBGroupName: "Group 1",
    });
  });

  it("should reject malformed engine configs from wrapper JSON", () => {
    expect(toEngineConfig({ id: { nested: true }, name: "bad" })).toBeNull();
    expect(toEngineConfig({ id: "engine-1", name: 123 })).toBeNull();
    expect(toEngineConfig(null)).toBeNull();
  });
});
