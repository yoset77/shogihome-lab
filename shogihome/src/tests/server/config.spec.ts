import { describe, expect, it } from "vitest";
import { parseIntegerConfigValue } from "@/server/config";

describe("server config parsing", () => {
  it("should fall back for invalid integer values", () => {
    expect(parseIntegerConfigValue("abc", "PORT", 8140, 1, 65535)).toBe(8140);
    expect(parseIntegerConfigValue("0", "PORT", 8140, 1, 65535)).toBe(8140);
    expect(parseIntegerConfigValue("70000", "PORT", 8140, 1, 65535)).toBe(8140);
  });

  it("should accept values inside the configured range", () => {
    expect(parseIntegerConfigValue("4082", "REMOTE_ENGINE_PORT", 8140, 1, 65535)).toBe(4082);
  });
});
