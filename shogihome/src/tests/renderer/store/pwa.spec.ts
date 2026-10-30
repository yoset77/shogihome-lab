import { createPwaUpdateStore } from "@/renderer/store/pwa";

describe("PWA update consent", () => {
  const canReload = vi.fn(() => true);
  const persist = vi.fn();
  const reload = vi.fn();
  const activate = vi.fn(async () => {});
  const makeStore = () => {
    const store = createPwaUpdateStore({ canReload, persist, reload });
    store.setUpdater(activate);
    return store;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    canReload.mockReturnValue(true);
    persist.mockReset();
    activate.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("notifies without activating or reloading, including repeated notifications", () => {
    const store = makeStore();
    store.onNeedRefresh();
    store.expanded = false;
    store.onNeedRefresh();
    expect(store.available).toBe(true);
    expect(store.expanded).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("hides a dismissed notice until the menu asks for it again", () => {
    const store = makeStore();
    store.dismiss();
    expect(store.expanded).toBe(true);
    store.onNeedRefresh();
    store.dismiss();
    expect(store.expanded).toBe(false);
    store.onNeedRefresh();
    store.onNeedReload();
    expect(store.expanded).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    store.show();
    expect(store.expanded).toBe(true);
    store.show();
    expect(store.expanded).toBe(true);
  });

  it("keeps the notice open while an update is being applied", async () => {
    const store = makeStore();
    store.onNeedRefresh();
    const applying = store.apply();
    store.dismiss();
    expect(store.expanded).toBe(true);
    await applying;
  });

  it("flushes before activation and again before reloading only the consenting page", async () => {
    const store = makeStore();
    store.onNeedRefresh();
    await store.apply();
    await store.apply();
    expect(activate).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenNthCalledWith(1, { forReload: false });
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(activate.mock.invocationCallOrder[0]);
    expect(reload).not.toHaveBeenCalled();
    store.onNeedReload();
    store.onNeedReload();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenNthCalledWith(2, { forReload: true });
    expect(reload).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reload when another tab activates the worker, but can apply afterwards", async () => {
    const first = makeStore();
    const second = makeStore();
    first.onNeedRefresh();
    second.onNeedRefresh();
    second.expanded = false;
    await first.apply();
    first.onNeedReload();
    second.onNeedReload();
    expect(reload).toHaveBeenCalledOnce();
    expect(second.expanded).toBe(false);
    await second.apply();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledOnce();
  });

  it("does nothing without an update or while application state is unsafe", async () => {
    const store = makeStore();
    await store.apply();
    store.onNeedRefresh();
    canReload.mockReturnValue(false);
    await store.apply();
    expect(persist).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("rechecks application state after activation and waits for another explicit attempt", async () => {
    const store = makeStore();
    store.onNeedRefresh();
    await store.apply();
    canReload.mockReturnValue(false);
    store.onNeedReload();
    expect(reload).not.toHaveBeenCalled();
    expect(store.applying).toBe(false);
    canReload.mockReturnValue(true);
    expect(reload).not.toHaveBeenCalled();
    await store.apply();
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([1, 2])("never reloads if persistence fails on flush %i", async (flush) => {
    const store = makeStore();
    store.onNeedRefresh();
    if (flush === 2) persist.mockImplementationOnce(() => {});
    persist.mockImplementationOnce(() => {
      throw new Error("quota exceeded");
    });
    await store.apply();
    if (flush === 2) store.onNeedReload();
    expect(store.failed).toBe(true);
    expect(store.applying).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(flush - 1);
  });

  it("shows activation errors without reloading and permits a retry", async () => {
    const store = makeStore();
    store.onNeedRefresh();
    activate.mockRejectedValueOnce(new Error("failed to activate"));
    await store.apply();
    expect(store.failed).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    await store.apply();
    expect(store.failed).toBe(false);
    store.onNeedReload();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("clears a stale failure when a new update becomes available", async () => {
    const store = makeStore();
    store.onNeedRefresh();
    activate.mockRejectedValueOnce(new Error("failed to activate"));
    await store.apply();
    expect(store.failed).toBe(true);
    store.onNeedRefresh();
    expect(store.failed).toBe(false);
  });

  it("clears a stale timeout failure when activation completes", async () => {
    const store = makeStore();
    store.onNeedRefresh();
    await store.apply();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.failed).toBe(true);
    store.onNeedReload();
    expect(store.failed).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("times out without forcing reload, even if activation finishes late", async () => {
    const store = makeStore();
    store.onNeedRefresh();
    await store.apply();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.failed).toBe(true);
    store.onNeedReload();
    expect(reload).not.toHaveBeenCalled();
    await store.apply();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("disposes a pending attempt", async () => {
    const store = makeStore();
    store.onNeedRefresh();
    await store.apply();
    store.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.failed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
