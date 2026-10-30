import type { RegisterSWOptions } from "vite-plugin-pwa/types";
import { setupPwaUpdates } from "@/renderer/webapp/update";
import { createPwaUpdateStore } from "@/renderer/store/pwa";
import api from "@/renderer/ipc/api";

vi.mock("@/renderer/ipc/api");

describe("PWA registration", () => {
  let dispose: () => void;
  let options: RegisterSWOptions;
  const activate = vi.fn(async () => {});
  const update = vi.fn(async () => undefined);
  const reload = vi.fn();
  const registration = { waiting: null, update } as unknown as ServiceWorkerRegistration;
  const container = Object.assign(new EventTarget(), {
    controller: {} as ServiceWorker | null,
  });
  const store = createPwaUpdateStore({ canReload: () => true, persist: vi.fn(), reload });
  const register = vi.fn((value: RegisterSWOptions = {}) => {
    options = value;
    return activate;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store.available = false;
    store.failed = false;
    container.controller = {} as ServiceWorker;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    dispose = setupPwaUpdates(register, store);
  });
  afterEach(() => {
    dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not notify on first installation", () => {
    options.onRegisteredSW?.("/sw.js", registration);
    expect(store.available).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores update prompts while the page is uncontrolled", () => {
    dispose();
    container.controller = null;
    dispose = setupPwaUpdates(register, store);
    options.onNeedRefresh?.();
    expect(store.available).toBe(false);
    container.controller = {} as ServiceWorker;
    options.onNeedRefresh?.();
    expect(store.available).toBe(true);
  });

  it("notifies for an already-waiting worker", () => {
    options.onRegisteredSW?.("/sw.js", {
      ...registration,
      waiting: {},
    } as ServiceWorkerRegistration);
    expect(store.available).toBe(true);
    expect(activate).not.toHaveBeenCalled();
  });

  it("uses explicit consent for plugin reload requests and external controller changes", () => {
    options.onNeedRefresh?.();
    options.onNeedReload?.();
    container.controller = {} as ServiceWorker;
    container.dispatchEvent(new Event("controllerchange"));
    expect(store.available).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores the first controller when initially uncontrolled", () => {
    dispose();
    container.controller = null;
    dispose = setupPwaUpdates(register, store);
    container.controller = {} as ServiceWorker;
    container.dispatchEvent(new Event("controllerchange"));
    expect(store.available).toBe(false);
  });

  it("checks periodically and on visibility with throttling, and cleans up", async () => {
    options.onRegisteredSW?.("/sw.js", registration);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(update).toHaveBeenCalledTimes(2);
    dispose();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("logs failed checks and registration without reloading", async () => {
    options.onRegisteredSW?.("/sw.js", registration);
    update.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    options.onRegisterError?.(new Error("registration failed"));
    expect(api.log).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not register in unsupported contexts", () => {
    dispose();
    Reflect.deleteProperty(navigator, "serviceWorker");
    register.mockClear();
    dispose = setupPwaUpdates(register, store);
    expect(register).not.toHaveBeenCalled();
  });

  it("tracks component-local dialog opening and closure reactively", async () => {
    options.onNeedRefresh?.();
    expect(store.canApply).toBe(true);
    const dialog = document.createElement("dialog");
    dialog.open = true;
    document.body.append(dialog);
    await Promise.resolve();
    expect(store.canApply).toBe(false);
    dialog.open = false;
    await Promise.resolve();
    expect(store.canApply).toBe(true);
    dialog.open = true;
    await Promise.resolve();
    expect(store.canApply).toBe(false);
    dialog.remove();
    await Promise.resolve();
    expect(store.canApply).toBe(true);
  });
});
