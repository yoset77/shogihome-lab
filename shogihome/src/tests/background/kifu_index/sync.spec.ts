import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { syncKifuDirectory, onKifuFileEvent, getSyncStatus } from "@/background/kifu_index/sync.js";
import {
  initDatabase,
  closeDatabase,
  getKifuCount,
  getKifuFileByPath,
} from "@/background/database/kifu_index.js";
import { clearKifuListCache } from "@/background/helpers/kifu.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("background/kifu_index/sync", () => {
  let tempDir: string;
  let dbDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-sync-"));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-db-"));
    initDatabase(dbDir);
    clearKifuListCache();
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("should sync directory correctly", async () => {
    // Create some kifu files
    fs.writeFileSync(
      path.join(tempDir, "test1.kif"),
      "先手：先手\n後手：後手\n手数----指手----\n1 ７六歩(77)\n",
    );
    fs.writeFileSync(
      path.join(tempDir, "test2.kif"),
      "先手：太郎\n後手：次郎\n手数----指手----\n1 ２六歩(27)\n",
    );

    await syncKifuDirectory(tempDir);

    expect(getKifuCount()).toBe(2);
    const status = getSyncStatus();
    expect(status.total).toBe(2);
    expect(status.indexed).toBe(2);
    expect(status.isIndexing).toBe(false);

    expect(getKifuFileByPath("test1.kif")).not.toBeUndefined();
    expect(getKifuFileByPath("test2.kif")).not.toBeUndefined();
  });

  it("should handle updates and deletions via events", async () => {
    const kifPath = "event_test.kif";
    const fullPath = path.join(tempDir, kifPath);
    fs.writeFileSync(fullPath, "先手：A\n後手：B\n手数----指手----\n1 ７六歩(77)\n");

    // Add event
    onKifuFileEvent("add", tempDir, kifPath);
    await new Promise((resolve) => setTimeout(resolve, 600)); // Wait for debounce
    expect(getKifuCount()).toBe(1);
    expect(getKifuFileByPath(kifPath)?.black_name).toBe("A");

    // Change event
    fs.writeFileSync(fullPath, "先手：C\n後手：D\n手数----指手----\n1 ７六歩(77)\n");
    onKifuFileEvent("change", tempDir, kifPath);
    await new Promise((resolve) => setTimeout(resolve, 600)); // Wait for debounce
    expect(getKifuCount()).toBe(1);
    expect(getKifuFileByPath(kifPath)?.black_name).toBe("C");

    // Unlink event
    onKifuFileEvent("unlink", tempDir, kifPath);
    await new Promise((resolve) => setTimeout(resolve, 600)); // Wait for debounce
    expect(getKifuCount()).toBe(0);
  });

  it("should only index changed files during full sync", async () => {
    const kifPath = "sync_test.kif";
    const fullPath = path.join(tempDir, kifPath);
    fs.writeFileSync(fullPath, "先手：A\n後手：B\n手数----指手----\n1 ７六歩(77)\n");

    await syncKifuDirectory(tempDir);
    expect(getKifuCount()).toBe(1);
    const indexedAt1 = getKifuFileByPath(kifPath)!.indexed_at;

    // Run sync again without changes
    await syncKifuDirectory(tempDir);
    const indexedAt2 = getKifuFileByPath(kifPath)!.indexed_at;
    expect(indexedAt2).toBe(indexedAt1); // Should NOT have been re-indexed

    // Update file
    // Need to wait a bit to ensure mtime changes (filesystem resolution)
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(fullPath, "先手：C\n後手：D\n手数----指手----\n1 ７六歩(77)\n");

    await syncKifuDirectory(tempDir);
    const indexedAt3 = getKifuFileByPath(kifPath)!.indexed_at;
    expect(indexedAt3).toBeGreaterThan(indexedAt1); // Should have been re-indexed
    expect(getKifuFileByPath(kifPath)?.black_name).toBe("C");
  });
});
