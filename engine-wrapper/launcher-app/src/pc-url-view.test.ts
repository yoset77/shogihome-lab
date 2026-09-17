import { describe, expect, it } from "vitest";
import { clearedPcUrlDisplay, resolvePcUrlDisplay } from "./pc-url-view";

describe("pc-url-view", () => {
  it("prefers the QR payload for text and opener", () => {
    const display = resolvePcUrlDisplay({
      url: "http://127.0.0.1:8140",
      allowed: true,
      qrUrl: "http://192.168.1.10:8140",
      bind: "0.0.0.0",
      autoOrigins: true,
    });
    expect(display.displayedUrl).toBe("http://192.168.1.10:8140");
    expect(display.hasQr).toBe(true);
    expect(display.qrUrl).toBe("http://192.168.1.10:8140");
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
    expect(display.hasQr).toBe(false);
    expect(display.openDisabled).toBe(true);
  });

  it("clears url, action, and QR together on failure", () => {
    const cleared = clearedPcUrlDisplay();
    expect(cleared.displayedUrl).toBe("");
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
