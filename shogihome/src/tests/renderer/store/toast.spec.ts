import { createToastStore, TOAST_DURATION_MS } from "@/renderer/store/toast";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("store/toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses short durations for routine notifications and longer durations for alerts", () => {
    expect(TOAST_DURATION_MS.info).toBe(2000);
    expect(TOAST_DURATION_MS.success).toBe(2000);
    expect(TOAST_DURATION_MS.warning).toBe(4000);
    expect(TOAST_DURATION_MS.error).toBe(4000);
  });

  it("adds toasts and dismisses them automatically", () => {
    const store = createToastStore();

    store.success("Saved");
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].type).toBe("success");

    vi.advanceTimersByTime(TOAST_DURATION_MS.success - 1);
    expect(store.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.toasts).toHaveLength(0);
  });

  it("aggregates duplicate notifications and resets their timer", () => {
    const store = createToastStore();

    store.warning("Connection lost");
    vi.advanceTimersByTime(TOAST_DURATION_MS.warning - 100);
    store.warning("Connection lost");

    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].count).toBe(2);
    vi.advanceTimersByTime(TOAST_DURATION_MS.warning - 101);
    expect(store.toasts).toHaveLength(1);
    vi.advanceTimersByTime(101);
    expect(store.toasts).toHaveLength(0);
  });

  it("replaces a keyed notification and resets its count", () => {
    const store = createToastStore();

    store.warning("Connection lost", { key: "connection-1" });
    store.warning("Connection lost", { key: "connection-1" });
    store.success("Reconnected", { key: "connection-1" });

    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0]).toMatchObject({
      type: "success",
      message: "Reconnected",
      count: 1,
      key: "connection-1",
    });
  });

  it("keeps at most three toasts and removes the oldest one", () => {
    const store = createToastStore();

    store.info("one");
    store.info("two");
    store.info("three");
    store.info("four");

    expect(store.toasts.map((toast) => toast.message)).toEqual(["two", "three", "four"]);
  });

  it("clears notifications and timers", () => {
    const store = createToastStore();

    store.error("Failed");
    store.clear();

    expect(store.toasts).toHaveLength(0);
    vi.runAllTimers();
    expect(store.toasts).toHaveLength(0);
  });
});
