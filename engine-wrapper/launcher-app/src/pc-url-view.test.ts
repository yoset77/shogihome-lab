import { describe, expect, it } from "vitest";
import { clearedPcUrlDisplay, isPcUrlClickable, resolvePcUrlDisplay, selectPcOpenTarget } from "./pc-url-view";

describe("pc-url-view", () => {
  it("keeps the QR payload for text but opens the loopback PC url", () => {
    const display = resolvePcUrlDisplay({
      url: "http://127.0.0.1:8140",
      allowed: true,
      qrUrl: "http://192.168.1.10:8140",
      bind: "0.0.0.0",
      autoOrigins: true,
    });
    expect(display.displayedUrl).toBe("http://192.168.1.10:8140");
    expect(display.openUrl).toBe("http://127.0.0.1:8140");
    expect(display.hasQr).toBe(true);
    expect(display.qrUrl).toBe("http://192.168.1.10:8140");
    expect(display.openDisabled).toBe(false);
  });

  it("opens the proxy origin when the PC url is not loopback", () => {
    const display = resolvePcUrlDisplay({
      url: "https://shogi.example.com",
      allowed: true,
      qrUrl: null,
      bind: "0.0.0.0",
      autoOrigins: false,
    });
    expect(display.displayedUrl).toBe("https://shogi.example.com");
    expect(display.openUrl).toBe("https://shogi.example.com");
    expect(display.hasQr).toBe(false);
    expect(display.openDisabled).toBe(false);
  });

  it("falls back to the PC url without a QR", () => {
    const display = resolvePcUrlDisplay({
      url: "http://127.0.0.1:8140",
      allowed: false,
      qrUrl: null,
      bind: "127.0.0.1",
      autoOrigins: true,
    });
    expect(display.displayedUrl).toBe("http://127.0.0.1:8140");
    expect(display.openUrl).toBe("http://127.0.0.1:8140");
    expect(display.hasQr).toBe(false);
    expect(display.openDisabled).toBe(true);
  });

  it("marks the URL text clickable only when allowed with an open target", () => {
    expect(isPcUrlClickable(resolvePcUrlDisplay({
      url: "http://127.0.0.1:8140",
      allowed: true,
      qrUrl: "http://192.168.1.10:8140",
      bind: "0.0.0.0",
      autoOrigins: true,
    }))).toBe(true);
    // Not allowed: the button is disabled, so the text must not open either.
    expect(isPcUrlClickable(resolvePcUrlDisplay({
      url: "http://127.0.0.1:8140",
      allowed: false,
      qrUrl: null,
      bind: "127.0.0.1",
      autoOrigins: true,
    }))).toBe(false);
    // Cleared state: no stale URL stays actionable.
    expect(isPcUrlClickable(clearedPcUrlDisplay())).toBe(false);
  });

  it("selects the cached open target, else a fresh allowed url", () => {
    // Cached target wins even when fresh info disagrees.
    expect(selectPcOpenTarget("http://127.0.0.1:8140", {
      url: "http://127.0.0.1:9000",
      allowed: true,
    })).toBe("http://127.0.0.1:8140");
    // No cache (e.g. after a failed refresh): retry the fresh payload.
    expect(selectPcOpenTarget("", {
      url: "http://127.0.0.1:8140",
      allowed: true,
    })).toBe("http://127.0.0.1:8140");
    // Disallowed strict origins: nothing safe to open.
    expect(selectPcOpenTarget("", {
      url: "http://127.0.0.1:8140",
      allowed: false,
    })).toBeNull();
    // Empty url or missing payload: nothing to open.
    expect(selectPcOpenTarget("", { url: "", allowed: true })).toBeNull();
    expect(selectPcOpenTarget("", null)).toBeNull();
  });

  it("clears url, action, and QR together on failure", () => {
    const cleared = clearedPcUrlDisplay();
    expect(cleared.displayedUrl).toBe("");
    expect(cleared.openUrl).toBe("");
    expect(cleared.qrUrl).toBeNull();
    expect(cleared.hasQr).toBe(false);
    expect(cleared.openDisabled).toBe(true);
    // A failed refresh applied over a previous success must leave no
    // stale QR scannable and no stale URL clickable.
    const stale = resolvePcUrlDisplay({
      url: "http://127.0.0.1:8140",
      allowed: true,
      qrUrl: "http://192.168.1.10:8140",
      bind: "0.0.0.0",
      autoOrigins: true,
    });
    expect(stale.qrUrl).not.toBeNull();
    expect(cleared).not.toEqual(stale);
  });
});
