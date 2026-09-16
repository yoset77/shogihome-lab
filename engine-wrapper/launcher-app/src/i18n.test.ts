import { describe, expect, it } from "vitest";
import { detectLang, normalizeLang, storedLang, storeLang, text } from "./i18n";

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

  it("normalizes and round-trips the persisted language", () => {
    expect(normalizeLang("en")).toBe("en");
    expect(normalizeLang("ja")).toBe("ja");
    expect(normalizeLang("fr")).toBeNull();
    expect(normalizeLang(null)).toBeNull();
    // Node (vitest) has no localStorage; browsers round-trip the value.
    const hasStorage = (() => {
      try {
        return typeof localStorage !== "undefined";
      } catch {
        return false;
      }
    })();
    if (hasStorage) {
      storeLang("en");
      expect(storedLang()).toBe("en");
      storeLang("ja");
      expect(storedLang()).toBe("ja");
    } else {
      expect(storedLang()).toBeNull();
    }
  });

  it("covers dashboard and editor chrome in both languages", () => {
    for (const lang of ["ja", "en"] as const) {
      for (const key of [
        "close",
        "editor.listTitle",
        "editor.manageGroups",
        "editor.addEngine",
        "editor.colName",
        "editor.editTitle",
        "editor.addTitle",
        "editor.nameLabel",
        "editor.typeGame",
        "editor.pathLabel",
        "editor.saveDbLabel",
        "editor.groupLabel",
        "editor.optionsLabel",
        "editor.apply",
        "editor.groupTitle",
        "editor.retry",
        "editor.browse",
        "editor.probe",
      ]) {
        expect(text(key, lang), `${key} (${lang})`).not.toBe(key);
      }
    }
    expect(text("editor.listTitle", "en")).toBe("Engine List");
    expect(text("close", "en")).toBe("Close");
  });
});
