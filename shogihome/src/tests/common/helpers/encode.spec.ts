import { describe, it, expect } from "vitest";
import { decodeText } from "@/common/helpers/encode";

describe("common/helpers/encode", () => {
  it("decodeText/SJIS with CP932 characters (Circled 1)", () => {
    // ① (Circled 1) is 0x87 0x40 in CP932
    const data = new Uint8Array([0x87, 0x40]);
    const decoded = decodeText(data, { encoding: "SJIS" });
    expect(decoded).toBe("①");
  });

  it("decodeText/SJIS with Ladder-style Taka (はしご高)", () => {
    // Ladder-style Taka (はしご高) is 0xFB 0xFC in CP932
    const data = new Uint8Array([0xfb, 0xfc]);
    const decoded = decodeText(data, { encoding: "SJIS" });
    // This previously failed with encoding-japanese (returning '?').
    // TextDecoder supports Windows-31J (CP932) extensions.
    expect(decoded).toBe("\u9AD9"); // 髙 (U+9AD9)
  });

  it("decodeText with autoDetect", () => {
    // SJIS "こんにちは"
    const data = new Uint8Array([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
    const decoded = decodeText(data, { autoDetect: true });
    expect(decoded).toBe("こんにちは");
  });

  it("decodeText with UTF8", () => {
    const data = new TextEncoder().encode("こんにちは");
    const decoded = decodeText(data, { encoding: "UTF8" });
    expect(decoded).toBe("こんにちは");
  });

  it("decodeText without options (default auto-detection)", () => {
    // SJIS "こんにちは"
    const data = new Uint8Array([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
    const decoded = decodeText(data); // No option
    expect(decoded).toBe("こんにちは");
  });

  it("decodeText with UNICODE encoding (edge case)", () => {
    // UNICODE in encoding-japanese means UTF-16 string (in convert result)
    // but as an input 'from' encoding, it behaves like auto-detect or specific internal format.
    // Here we just test it doesn't throw and returns something sensible.
    const data = new TextEncoder().encode("test");
    const decoded = decodeText(data, { encoding: "UNICODE" });
    expect(decoded).toBe("test");
  });
});
