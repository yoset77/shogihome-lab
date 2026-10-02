import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseAllowedFetchDomains,
  parseIntegerConfigValue,
  resolveBasePath,
} from "@/server/config";

describe("server config parsing", () => {
  it("should fall back for invalid integer values", () => {
    expect(parseIntegerConfigValue("abc", "PORT", 8140, 1, 65535)).toBe(8140);
    expect(parseIntegerConfigValue("0", "PORT", 8140, 1, 65535)).toBe(8140);
    expect(parseIntegerConfigValue("70000", "PORT", 8140, 1, 65535)).toBe(8140);
  });

  it("should accept values inside the configured range", () => {
    expect(parseIntegerConfigValue("4082", "REMOTE_ENGINE_PORT", 8140, 1, 65535)).toBe(4082);
  });

  it("should parse allowed fetch domains consistently", () => {
    expect([...parseAllowedFetchDomains(" example.com,EXAMPLE.org ,, ")].sort()).toEqual([
      "example.com",
      "example.org",
    ]);
  });

  it("should resolve the Docker runtime base path from the working directory", () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-runtime-"));
    fs.mkdirSync(path.join(runtimeDir, "docs", "webapp"), { recursive: true });
    const moduleUrl = pathToFileURL(path.join(runtimeDir, "server.js")).href;

    try {
      expect(resolveBasePath(moduleUrl, runtimeDir, process.execPath)).toBe(runtimeDir);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

describe("book resource configuration", () => {
  const settings = [
    { name: "ONTHEFLY_THRESHOLD_MB", defaultValue: 64, min: 1, max: 128 },
    { name: "SBK_ONTHEFLY_THRESHOLD_MB", defaultValue: 32, min: 1, max: 64 },
  ] as const;

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
    for (const { name } of settings) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each(settings)("uses the default for $name when unset", async ({ name, defaultValue }) => {
    const config = await import("@/server/config");
    expect(config[name]).toBe(defaultValue);
  });

  it.each(settings)("accepts both bounds for $name", async ({ name, min, max }) => {
    for (const value of [min, max]) {
      vi.stubEnv(name, String(value));
      vi.resetModules();
      const config = await import("@/server/config");
      expect(config[name]).toBe(value);
    }
  });

  it.each(settings)(
    "falls back for invalid or out-of-range $name",
    async ({ name, defaultValue, min, max }) => {
      for (const value of ["invalid", String(min - 1), String(max + 1)]) {
        vi.stubEnv(name, value);
        vi.resetModules();
        const config = await import("@/server/config");
        expect(config[name]).toBe(defaultValue);
      }
    },
  );
});
