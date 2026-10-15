// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, type SettingsSchema } from "./api";
import { initSettingsWindow } from "./settings-window";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  message: vi.fn(),
  open: vi.fn(),
}));
vi.mock("./api", () => ({
  api: {
    getUiLanguage: vi.fn(),
    getSettingsSchema: vi.fn(),
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    restartServices: vi.fn(),
    closeSettingsWindow: vi.fn(),
  },
}));

const html = readFileSync(new NodeURL("../settings.html", import.meta.url), "utf8");
const schema: SettingsSchema = {
  sections: ["basic", "kifu"],
  settings: [
    {
      id: "PORT", type: "int", section: "basic", default: "8140",
      min: 1, max: 65535, choices: [], listRule: "none",
    },
    {
      id: "ANALYSIS_DB_MIN_DEPTH", type: "int", section: "kifu", default: "10",
      min: 0, max: 100, choices: [], listRule: "none",
    },
  ],
};

describe.each(["ja", "en"] as const)("server settings validation (%s)", (lang) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.stubGlobal("alert", vi.fn());
    localStorage.clear();
    document.body.innerHTML = html;
    vi.mocked(api.getUiLanguage).mockResolvedValue(lang);
    vi.mocked(api.getSettingsSchema).mockResolvedValue(schema);
    vi.mocked(api.loadSettings).mockResolvedValue({ values: {}, mismatches: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function saveInvalid(id: string, value: string, error: unknown) {
    initSettingsWindow();
    const selector = `#settingsForm [data-setting-id="${id}"]`;
    await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    vi.mocked(api.saveSettings).mockRejectedValueOnce(error);
    document.getElementById("saveSettingsBtn")!.click();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
    expect(ask).not.toHaveBeenCalled();
    expect(api.restartServices).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(api.closeSettingsWindow).not.toHaveBeenCalled();
    expect(input.value).toBe(value);
  }

  it.each([
    { id: "PORT", value: "0", min: 1, max: 65535 },
    { id: "PORT", value: "70000", min: 1, max: 65535 },
    { id: "ANALYSIS_DB_MIN_DEPTH", value: "-1", min: 0, max: 100 },
    { id: "ANALYSIS_DB_MIN_DEPTH", value: "101", min: 0, max: 100 },
  ])("shows the schema bounds when $id is $value", async ({ id, value, min, max }) => {
    await saveInvalid(id, value, JSON.stringify({ [id]: "out_of_range" }));
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ [id]: value }));
    expect(alert).toHaveBeenCalledWith(
      lang === "ja"
        ? `${id} は ${min}〜${max} の範囲で入力してください`
        : `${id} must be between ${min} and ${max}`,
    );
  });

  it("keeps invalid integer errors localized", async () => {
    await saveInvalid("PORT", "abc", JSON.stringify({ PORT: "invalid_int" }));
    expect(alert).toHaveBeenCalledWith(
      lang === "ja" ? "PORT には数値を入力してください" : "PORT must be a number",
    );
  });

  it.each(["disk full", new Error("disk full")])("preserves non-validation errors: %s", async (error) => {
    await saveInvalid("PORT", "9000", error);
    expect(alert).toHaveBeenCalledWith("disk full");
  });
});
