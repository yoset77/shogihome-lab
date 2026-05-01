import { describe, expect, it } from "vitest";
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
