import { validatePlayerSettings } from "@/common/settings/player";

describe("settings/player", () => {
  it.each(["es://human", "lan-engine", "lan-engine:test-engine"])("accepts %s", (uri) => {
    expect(validatePlayerSettings({ name: "Player", uri })).toBeUndefined();
  });

  it.each([
    "",
    "es://usi-engine/test",
    "es://basic-engine/random",
    "lan-engine:",
    "lan-engine-other",
    "lan-engine:../test",
  ])("rejects unsupported or malformed URI %s", (uri) =>
    expect(validatePlayerSettings({ name: "Player", uri })).toBeInstanceOf(Error),
  );

  it("requires a player name", () => {
    expect(validatePlayerSettings({ name: "", uri: "es://human" })).toBeInstanceOf(Error);
  });
});
