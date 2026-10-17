// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import { ask, message } from "@tauri-apps/plugin-dialog";
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
  sections: ["basic", "kifu", "security"],
  settings: [
    {
      id: "PORT", type: "int", section: "basic", default: "8140",
      min: 1, max: 65535, choices: [], listRule: "none",
    },
    {
      id: "ANALYSIS_DB_MIN_DEPTH", type: "int", section: "kifu", default: "10",
      min: 0, max: 100, choices: [], listRule: "none",
    },
    {
      id: "WRAPPER_ACCESS_TOKEN", type: "text", section: "security", default: "",
      min: null, max: null, choices: [], listRule: "none",
    },
  ],
};

describe.each(["ja", "en"] as const)("server settings (%s)", (lang) => {
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

  async function openSettings() {
    initSettingsWindow();
    await vi.waitFor(() => expect(document.querySelector("#settingsForm input")).not.toBeNull());
  }

  it("hands off the restart and closes without waiting for it to finish", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(api.restartServices).mockReturnValue(new Promise(() => {}));
    await openSettings();
    document.getElementById("saveSettingsBtn")!.click();

    await vi.waitFor(() => expect(api.closeSettingsWindow).toHaveBeenCalledOnce());
    expect(emit).toHaveBeenCalledExactlyOnceWith("settings-saved", { restart: true });
    expect(api.restartServices).not.toHaveBeenCalled();
    expect(vi.mocked(emit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.closeSettingsWindow).mock.invocationCallOrder[0],
    );
  });

  it("notifies the dashboard and closes when restart is declined", async () => {
    vi.mocked(ask).mockResolvedValue(false);
    await openSettings();
    document.getElementById("saveSettingsBtn")!.click();

    await vi.waitFor(() => expect(api.closeSettingsWindow).toHaveBeenCalledOnce());
    expect(emit).toHaveBeenCalledExactlyOnceWith("settings-saved", { restart: false });
    expect(api.restartServices).not.toHaveBeenCalled();
  });

  it("waits for the handoff before closing", async () => {
    let handoff!: () => void;
    vi.mocked(emit).mockReturnValue(new Promise<void>((resolve) => { handoff = resolve; }));
    vi.mocked(ask).mockResolvedValue(true);
    await openSettings();
    document.getElementById("saveSettingsBtn")!.click();

    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    expect(api.closeSettingsWindow).not.toHaveBeenCalled();
    expect(api.restartServices).not.toHaveBeenCalled();
    handoff();
    await vi.waitFor(() => expect(api.closeSettingsWindow).toHaveBeenCalledOnce());
  });

  it("keeps the window open if handing off the restart fails", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(emit).mockRejectedValue("event failed");
    await openSettings();
    document.getElementById("saveSettingsBtn")!.click();

    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith("event failed"));
    expect(api.closeSettingsWindow).not.toHaveBeenCalled();
    expect(api.restartServices).not.toHaveBeenCalled();
  });

  it("reports a close failure after handing off the restart", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(api.closeSettingsWindow).mockRejectedValue("close failed");
    await openSettings();
    document.getElementById("saveSettingsBtn")!.click();

    await vi.waitFor(() => expect(message).toHaveBeenCalledWith("close failed", {
      title: lang === "ja" ? "エラー" : "Error", kind: "error",
    }));
    expect(emit).toHaveBeenCalledExactlyOnceWith("settings-saved", { restart: true });
    expect(api.restartServices).not.toHaveBeenCalled();
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

  it.each(["secret-token", " ".repeat(32), "\u3000".repeat(32)])(
    "keeps invalid access tokens open with a localized error: %j",
    async (value) => {
      await saveInvalid(
        "WRAPPER_ACCESS_TOKEN", value,
        JSON.stringify({ WRAPPER_ACCESS_TOKEN: "invalid_access_token" }),
      );
      expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ WRAPPER_ACCESS_TOKEN: value }));
      expect(alert).toHaveBeenCalledWith(
        lang === "ja"
          ? "WRAPPER_ACCESS_TOKEN は32文字以上で、空白のみではない値を入力するか、空欄にしてください"
          : "WRAPPER_ACCESS_TOKEN must be empty or contain at least 32 characters and not consist only of whitespace",
      );
    },
  );

  it.each(["disk full", new Error("disk full")])("preserves non-validation errors: %s", async (error) => {
    await saveInvalid("PORT", "9000", error);
    expect(alert).toHaveBeenCalledWith("disk full");
  });
});
