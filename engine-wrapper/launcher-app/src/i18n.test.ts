import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  describe("detectLang", () => {
    beforeEach(() => {
      vi.stubEnv("SHOGIHOME_LAB_LANG", undefined);
      vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
      vi.stubGlobal("navigator", undefined);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it.each([
      ["ja", "ja"],
      ["ja-JP", "ja"],
      ["JA-jp", "ja"],
      ["en-US", "en"],
      ["fr-FR", "en"],
      ["zh-CN", "en"],
      ["", "en"],
      [undefined, "en"],
    ])("detects navigator.language %s as %s without persisting it", (language, expected) => {
      vi.stubGlobal("navigator", { language });
      expect(detectLang()).toBe(expected);
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });

    it("falls back to English without navigator", () => {
      expect(detectLang()).toBe("en");
    });

    it.each([
      ["ja", "en-US"],
      ["en", "ja-JP"],
    ])("prefers saved %s over navigator.language %s", (saved, language) => {
      vi.stubGlobal("localStorage", { getItem: vi.fn(() => saved) });
      vi.stubGlobal("navigator", { language });
      expect(detectLang()).toBe(saved);
    });

    it("preserves the environment override over saved and detected languages", () => {
      vi.stubEnv("SHOGIHOME_LAB_LANG", "en");
      vi.stubGlobal("localStorage", { getItem: vi.fn(() => "ja") });
      vi.stubGlobal("navigator", { language: "ja-JP" });
      expect(detectLang()).toBe("en");
    });

    it("ignores unsupported environment and saved languages", () => {
      vi.stubEnv("SHOGIHOME_LAB_LANG", "fr");
      vi.stubGlobal("localStorage", { getItem: vi.fn(() => "fr") });
      vi.stubGlobal("navigator", { language: "en-US" });
      expect(detectLang()).toBe("en");
    });

    it("detects the language when localStorage is unavailable", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("Storage blocked");
        },
      });
      vi.stubGlobal("navigator", { language: "en-US" });
      expect(detectLang()).toBe("en");
    });
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
        "settingsDesc_ENGINE_HIGH_QOS",
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
        "editor.groupNameTitle",
        "editor.groupRenameTitle",
        "editor.groupNameLabel",
        "editor.retry",
        "editor.browse",
        "editor.probe",
      ]) {
        expect(text(key, lang), `${key} (${lang})`).not.toBe(key);
      }
    }
    expect(text("editor.listTitle", "en")).toBe("Engine List");
    expect(text("close", "en")).toBe("Close");
    expect(text("settingsRestartPrompt", "ja")).toBe("設定を保存しました。サーバーを再起動しますか？");
    expect(text("settingsRestartPrompt", "en")).toBe("Settings saved. Restart the server now?");
    expect(text("settingsDesc_ENGINE_HIGH_QOS", "ja")).toContain("パフォーマンスを優先");
    expect(text("settingsDesc_ENGINE_HIGH_QOS", "en")).toContain("engine performance");
  });
});
