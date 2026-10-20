import { getLanEngineId, isLanEngineURI } from "@/common/uri";

describe("LAN engine URI", () => {
  it.each(["test", "Test_1.2-3", "game", "research", "mate"])("accepts explicit ID %s", (id) => {
    const uri = `lan-engine:${id}`;
    expect(isLanEngineURI(uri)).toBe(true);
    expect(getLanEngineId(uri, "research")).toBe(id);
  });

  it.each(["game", "research", "mate"] as const)("maps the legacy alias to %s", (type) => {
    expect(isLanEngineURI("lan-engine")).toBe(true);
    expect(getLanEngineId("lan-engine", type)).toBe(type);
  });

  it.each([
    "",
    "es://human",
    "es://usi-engine/test",
    "lan-engine-other",
    "lan-engine:",
    "lan-engine:../test",
    "lan-engine:test engine",
    "lan-engine:日本語",
  ])("rejects %s", (uri) => {
    expect(isLanEngineURI(uri)).toBe(false);
    expect(getLanEngineId(uri, "research")).toBeUndefined();
  });
});
