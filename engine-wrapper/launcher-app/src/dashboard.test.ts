// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { initDashboard } from "./dashboard";
import { startAfterMigration } from "./startup";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./startup", () => ({ startAfterMigration: vi.fn() }));
vi.mock("./api", () => ({
  api: {
    getUiLanguage: vi.fn(),
    getStatus: vi.fn(),
    getPcUrl: vi.fn(),
    checkUpdate: vi.fn(),
    restartServices: vi.fn(),
  },
}));

const html = readFileSync(new NodeURL("../index.html", import.meta.url), "utf8");
const listeners = new Map<string, EventCallback<unknown>>();

function emitEvent(event: string, payload: unknown = {}) {
  const listener = listeners.get(event);
  expect(listener).toBeDefined();
  listener!({ event, id: 0, payload });
}

describe.each(["ja", "en"] as const)("dashboard settings restart (%s)", (lang) => {
  const restartButton = () => document.getElementById("restartBtn") as HTMLButtonElement;
  const statusLabel = () => document.getElementById("statusLabel")!;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    listeners.clear();
    localStorage.clear();
    document.body.innerHTML = html;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      listeners.set(event, handler as EventCallback<unknown>);
      return vi.fn<() => void>();
    });
    vi.mocked(api.getUiLanguage).mockResolvedValue(lang);
    vi.mocked(api.getStatus).mockResolvedValue({ state: "running", services: {} });
    vi.mocked(api.getPcUrl).mockResolvedValue({
      url: "http://127.0.0.1:8140", allowed: true, qrUrl: null,
      bind: "127.0.0.1", autoOrigins: true,
    });
    vi.mocked(api.checkUpdate).mockResolvedValue(null);
    vi.mocked(startAfterMigration).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function openDashboard() {
    initDashboard();
    await vi.waitFor(() => {
      expect(listeners.has("settings-saved")).toBe(true);
      expect(api.checkUpdate).toHaveBeenCalledOnce();
      expect(restartButton().disabled).toBe(false);
    });
  }

  it("owns the requested restart and refreshes the URL after completion", async () => {
    let finish!: (generation: number) => void;
    vi.mocked(api.restartServices).mockReturnValue(new Promise<number>((resolve) => { finish = resolve; }));
    await openDashboard();
    const initialRefreshes = vi.mocked(api.getPcUrl).mock.calls.length;

    emitEvent("settings-saved", { restart: true });
    expect(api.restartServices).toHaveBeenCalledOnce();
    expect(restartButton().disabled).toBe(true);
    expect(statusLabel().textContent).toBe(lang === "ja" ? "再起動中..." : "Restarting...");
    expect(api.getPcUrl).toHaveBeenCalledTimes(initialRefreshes);

    // Polling must not re-enable restart while the operation is still pending.
    await vi.advanceTimersByTimeAsync(2000);
    expect(restartButton().disabled).toBe(true);
    expect(statusLabel().textContent).toBe(lang === "ja" ? "再起動中..." : "Restarting...");
    vi.mocked(api.getPcUrl).mockResolvedValue({
      url: "http://127.0.0.1:9000", allowed: true, qrUrl: null,
      bind: "127.0.0.1", autoOrigins: true,
    });
    finish(2);

    await vi.waitFor(() => {
      expect(restartButton().disabled).toBe(false);
      expect(document.getElementById("pcUrl")!.textContent).toBe("http://127.0.0.1:9000");
    });
    expect(statusLabel().textContent).toBe(lang === "ja" ? "● 実行中" : "● Running");
    expect(message).not.toHaveBeenCalled();
  });

  it.each([false, undefined, "true", null])("only refreshes when restart is not explicitly true (%s)", async (restart) => {
    await openDashboard();
    vi.mocked(api.getPcUrl).mockClear();

    emitEvent("settings-saved", { restart });

    await vi.waitFor(() => expect(api.getPcUrl).toHaveBeenCalledOnce());
    expect(api.restartServices).not.toHaveBeenCalled();
    expect(restartButton().disabled).toBe(false);
  });

  it("shares the restart button's handler and prevents repeated button clicks", async () => {
    let finish!: (generation: number) => void;
    vi.mocked(api.restartServices).mockReturnValue(new Promise<number>((resolve) => { finish = resolve; }));
    await openDashboard();

    restartButton().click();
    expect(restartButton().disabled).toBe(true);
    restartButton().click();
    expect(api.restartServices).toHaveBeenCalledOnce();
    finish(2);
    await vi.waitFor(() => expect(restartButton().disabled).toBe(false));
  });

  it("keeps a settings restart requested during an earlier restart", async () => {
    let finishFirst!: (generation: number) => void;
    let finishSecond!: (generation: number) => void;
    vi.mocked(api.restartServices)
      .mockReturnValueOnce(new Promise<number>((resolve) => { finishFirst = resolve; }))
      .mockReturnValueOnce(new Promise<number>((resolve) => { finishSecond = resolve; }));
    await openDashboard();
    const initialRefreshes = vi.mocked(api.getPcUrl).mock.calls.length;

    restartButton().click();
    emitEvent("settings-saved", { restart: true });
    expect(api.restartServices).toHaveBeenCalledTimes(2);
    finishFirst(2);
    await vi.waitFor(() => expect(api.getPcUrl).toHaveBeenCalledTimes(initialRefreshes + 1));
    expect(restartButton().disabled).toBe(true);
    expect(statusLabel().textContent).toBe(lang === "ja" ? "再起動中..." : "Restarting...");
    finishSecond(3);
    await vi.waitFor(() => expect(restartButton().disabled).toBe(false));
  });

  it("reports a failed settings restart from the dashboard and allows retry", async () => {
    vi.mocked(api.restartServices).mockImplementationOnce(async () => {
      vi.mocked(api.getStatus).mockResolvedValue({ state: "failed", services: {} });
      throw new Error("restart failed");
    });
    await openDashboard();

    emitEvent("settings-saved", { restart: true });

    await vi.waitFor(() => expect(message).toHaveBeenCalledExactlyOnceWith("Error: restart failed", {
      title: lang === "ja" ? "エラー" : "Error", kind: "error",
    }));
    expect(statusLabel().textContent).toBe(lang === "ja" ? "● エラー" : "● Error");
    expect(restartButton().disabled).toBe(false);
    vi.mocked(api.restartServices).mockResolvedValueOnce(3);
    restartButton().click();
    await vi.waitFor(() => expect(api.restartServices).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(restartButton().disabled).toBe(false));
  });
});
