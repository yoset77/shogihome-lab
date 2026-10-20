import { resolveLanEngine } from "@/renderer/helpers/engine";

describe("resolveLanEngine", () => {
  const engines = [{ id: "test", name: "Test engine" }];
  it("resolves the discovery name without local engine settings", () => {
    expect(resolveLanEngine("lan-engine:test", engines, "research")).toEqual({
      uri: "lan-engine:test",
      name: "Test engine",
    });
  });
  it("keeps a reference when discovery data is temporarily unavailable", () => {
    expect(resolveLanEngine("lan-engine:test", [], "research")).toEqual({
      uri: "lan-engine:test",
      name: "test",
    });
  });
  it.each(["game", "research", "mate"] as const)(
    "resolves the legacy alias using the %s default",
    (type) => {
      expect(resolveLanEngine("lan-engine", [{ id: type, name: "Default engine" }], type)).toEqual({
        uri: "lan-engine",
        name: "Default engine",
      });
      expect(resolveLanEngine("lan-engine", [], type)).toEqual({ uri: "lan-engine", name: type });
    },
  );
  it.each(["", "es://human", "es://usi-engine/test", "lan-engine:", "lan-engine:../test"])(
    "rejects %s",
    (uri) => {
      expect(resolveLanEngine(uri, engines, "research")).toBeUndefined();
    },
  );
});
