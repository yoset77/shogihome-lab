import { resolveLanEngine } from "@/renderer/helpers/engine";

describe("resolveLanEngine", () => {
  const engines = [{ id: "test", name: "Test engine" }];
  it("resolves the discovery name without local engine settings", () => {
    expect(resolveLanEngine("lan-engine:test", engines)).toEqual({
      uri: "lan-engine:test",
      name: "Test engine",
    });
  });
  it("keeps a reference when discovery data is temporarily unavailable", () => {
    expect(resolveLanEngine("lan-engine:test", [])).toEqual({
      uri: "lan-engine:test",
      name: "test",
    });
  });
  it("preserves the legacy LAN alias", () => {
    expect(resolveLanEngine("lan-engine", [])?.uri).toBe("lan-engine");
  });
  it.each(["", "es://human", "es://usi-engine/test", "lan-engine:", "lan-engine:../test"])(
    "rejects %s",
    (uri) => {
      expect(resolveLanEngine(uri, engines)).toBeUndefined();
    },
  );
});
