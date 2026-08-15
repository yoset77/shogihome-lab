import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("background/kifu_index/strategy model", () => {
  afterEach(() => {
    vi.doUnmock("@/server/config");
    vi.restoreAllMocks();
  });

  it("rejects a model trained for a different initial position", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-strategy-model-"));
    const modelDir = path.join(tempDir, "dist", "server", "models", "strategy");
    const sourceDir = path.join(process.cwd(), "src", "server", "kifu_index", "models");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.copyFileSync(path.join(sourceDir, "weights.f64"), path.join(modelDir, "weights.f64"));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(sourceDir, "manifest.json"), "utf-8"),
    ) as Record<string, unknown>;
    manifest.initialSfen = "different initial position";
    fs.writeFileSync(path.join(modelDir, "manifest.json"), JSON.stringify(manifest));

    vi.resetModules();
    vi.doMock("@/server/config", () => ({ getBasePath: () => tempDir }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const { isStrategyModelAvailable } = await import("@/server/kifu_index/strategy");
      expect(isStrategyModelAvailable()).toBe(false);
      expect(isStrategyModelAvailable()).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      errorSpy.mockRestore();
    }
  });
});
