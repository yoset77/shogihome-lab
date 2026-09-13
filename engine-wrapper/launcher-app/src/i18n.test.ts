import { describe, expect, it } from "vitest";
import { detectLang, text } from "./i18n";

describe("i18n", () => {
  it("resolves both languages and falls back to the key", () => {
    expect(text("stopAndExit", "ja")).toBe("停止して終了");
    expect(text("stopAndExit", "en")).toBe("Stop & Exit");
    expect(text("missing.key", "ja")).toBe("missing.key");
    expect(text("editor.save", "en")).toBe("Save settings");
    expect(text("settingsDesc_PORT", "ja")).toContain("ポート");
  });

  it("formats callable entries", () => {
    expect(text("editor.duplicateId", "ja", "x")).toContain("x");
    expect(text("settingsError_out_of_range", "en", "PORT", "1", "9")).toContain("1");
  });

  it("detects language from the environment", () => {
    expect(["ja", "en"]).toContain(detectLang());
  });
});
