import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { syncKifuDirectory, onKifuFileEvent, getSyncStatus } from "@/server/kifu_index/sync";
import {
  initDatabase,
  closeDatabase,
  getKifuCount,
  getKifuFileByPath,
} from "@/server/database/kifu_index";
import * as kifuIndexDB from "@/server/database/kifu_index";
import { clearKifuListCache } from "@/server/helpers/kifu";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { STRATEGY_INDEX_VERSION } from "@/server/kifu_index/strategy";

const engineGate = vi.hoisted(() => ({
  path: undefined as string | undefined,
  promise: undefined as Promise<void> | undefined,
}));

vi.mock("@/server/kifu_index/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/kifu_index/engine")>();
  return {
    ...actual,
    parseAndIndexFile: vi.fn(async (kifuDir: string, relPath: string) => {
      if (engineGate.path === relPath && engineGate.promise) {
        await engineGate.promise;
      }
      return actual.parseAndIndexFile(kifuDir, relPath);
    }),
  };
});

import { parseAndIndexFile } from "@/server/kifu_index/engine";

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
    engineGate.path = undefined;
    engineGate.promise = undefined;
  });

  function insertLegacyOrphan(sfen: string): void {
    const testDb = new DatabaseSync(path.join(dbDir, "kifu_index.db"));
    try {
      testDb.prepare("INSERT INTO positions (sfen_hash, sfen) VALUES (?, ?)").run(999, sfen);
    } finally {
      testDb.close();
    }
  }

  function hasPosition(sfen: string): boolean {
    const testDb = new DatabaseSync(path.join(dbDir, "kifu_index.db"));
    try {
      return testDb.prepare("SELECT 1 FROM positions WHERE sfen = ?").get(sfen) !== undefined;
    } finally {
      testDb.close();
    }
  }

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

  it.each(["add", "change"] as const)(
    "keeps a recreated file indexed after a directory removal and %s in the same batch",
    async (event) => {
      const directory = path.join(tempDir, "games");
      const relPath = "games/game.kif";
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(tempDir, relPath), "先手：Old\n手数----指手----\n1 ７六歩(77)\n");
      await syncKifuDirectory(tempDir);
      fs.rmSync(directory, { recursive: true });
      onKifuFileEvent("unlink", tempDir, relPath);
      onKifuFileEvent("unlinkDir", tempDir, "games");
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(tempDir, relPath), "先手：New\n手数----指手----\n1 ７六歩(77)\n");
      onKifuFileEvent(event, tempDir, relPath);

      await vi.waitFor(() => expect(getKifuFileByPath(relPath)?.black_name).toBe("New"), {
        timeout: 3000,
      });
      expect(getKifuCount()).toBe(1);
    },
  );

  it("re-indexes a file re-added to a removed directory in a later batch", async () => {
    const directory = path.join(tempDir, "games");
    const removedPath = "games/game.kif";
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(tempDir, removedPath),
      "先手：Old\n手数----指手----\n1 ７六歩(77)\n",
    );
    fs.writeFileSync(path.join(tempDir, "kept.kif"), "先手：Old\n手数----指手----\n1 ７六歩(77)\n");
    await syncKifuDirectory(tempDir);
    const callsBeforeBatch = vi.mocked(parseAndIndexFile).mock.calls.length;

    // Hold the first batch on a slow parse so it outlives the next batch's debounce.
    let release!: () => void;
    const gated = new Promise<void>((resolve) => (release = resolve));
    engineGate.path = "kept.kif";
    engineGate.promise = gated;

    try {
      // Batch A: directory removal plus a slow change outside the removed directory.
      fs.rmSync(directory, { recursive: true });
      onKifuFileEvent("unlinkDir", tempDir, "games");
      onKifuFileEvent("change", tempDir, "kept.kif");
      // Batch A started when its slow parse call appears.
      await vi.waitFor(
        () => expect(parseAndIndexFile).toHaveBeenCalledTimes(callsBeforeBatch + 1),
        { timeout: 3000 },
      );

      // Re-add the removed file while batch A is still processing.
      fs.mkdirSync(directory);
      fs.writeFileSync(
        path.join(tempDir, removedPath),
        "先手：New\n手数----指手----\n1 ７六歩(77)\n",
      );
      onKifuFileEvent("add", tempDir, removedPath);
      await new Promise((resolve) => setTimeout(resolve, 600));

      // The next batch must not run concurrently with the unfinished one.
      expect(parseAndIndexFile).toHaveBeenCalledTimes(callsBeforeBatch + 1);

      release();
      await vi.waitFor(() => expect(getKifuFileByPath(removedPath)?.black_name).toBe("New"), {
        timeout: 3000,
      });
      expect(getKifuFileByPath("kept.kif")?.black_name).toBe("Old");
      expect(getKifuCount()).toBe(2);
      // Let the echoing batch tail (list refresh) settle before the teardown
      // removes the temporary directory.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      release();
    }
  });

  it("does not scan all indexed paths for ordinary file removals", async () => {
    for (const name of ["first.kif", "second.kif", "kept.kif"]) {
      fs.writeFileSync(path.join(tempDir, name), "手数----指手----\n1 ７六歩(77)\n");
    }
    await syncKifuDirectory(tempDir);
    const allPaths = vi.spyOn(kifuIndexDB, "getAllKifuFilePaths");
    try {
      for (const name of ["first.kif", "second.kif"]) {
        fs.rmSync(path.join(tempDir, name));
        onKifuFileEvent("unlink", tempDir, name);
      }
      await vi.waitFor(() => expect(getKifuCount()).toBe(1), { timeout: 3000 });
      expect(getKifuFileByPath("kept.kif")).toBeDefined();
      expect(allPaths).not.toHaveBeenCalled();
    } finally {
      allPaths.mockRestore();
    }
  });

  it("scans indexed paths once for overlapping directory removals and preserves adjacent paths", async () => {
    const removed = ["games/first.kif", "games/nested/second.kif", "other/third.kif"];
    const kept = "games-old/kept.kif";
    for (const name of [...removed, kept]) {
      fs.mkdirSync(path.dirname(path.join(tempDir, name)), { recursive: true });
      fs.writeFileSync(path.join(tempDir, name), "手数----指手----\n1 ７六歩(77)\n");
    }
    await syncKifuDirectory(tempDir);
    const allPaths = vi.spyOn(kifuIndexDB, "getAllKifuFilePaths");
    try {
      for (const directory of ["games", "other"]) {
        fs.rmSync(path.join(tempDir, directory), { recursive: true });
      }
      onKifuFileEvent("unlink", tempDir, removed[0]);
      for (const directory of ["games/nested", "games", "other"]) {
        onKifuFileEvent("unlinkDir", tempDir, directory);
      }
      await vi.waitFor(() => expect(getKifuCount()).toBe(1), { timeout: 3000 });
      expect(getKifuFileByPath(kept)).toBeDefined();
      for (const name of removed) expect(getKifuFileByPath(name)).toBeUndefined();
      expect(allPaths).toHaveBeenCalledOnce();
    } finally {
      allPaths.mockRestore();
    }
  });

  it("yields to the event loop before finishing a large directory removal", async () => {
    fs.mkdirSync(path.join(tempDir, "games"));
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(tempDir, "games", `${i}.kif`), "手数----指手----\n1 ７六歩(77)\n");
    }
    await syncKifuDirectory(tempDir);
    const originalDelete = kifuIndexDB.deleteKifuFile;
    let scheduled = false;
    let remainingWhenYielded: number | undefined;
    const remove = vi.spyOn(kifuIndexDB, "deleteKifuFile").mockImplementation((filePath) => {
      originalDelete(filePath);
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          remainingWhenYielded = getKifuCount();
        });
      }
    });
    try {
      fs.rmSync(path.join(tempDir, "games"), { recursive: true });
      onKifuFileEvent("unlinkDir", tempDir, "games");
      await vi.waitFor(() => expect(getKifuCount()).toBe(0), { timeout: 3000 });
      expect(remainingWhenYielded).toBeGreaterThan(0);
      expect(remainingWhenYielded).toBeLessThan(25);
    } finally {
      remove.mockRestore();
    }
  });

  it("defers legacy orphan repair from live events to full sync", async () => {
    const orphanSfen = "legacy-orphan";
    const kifPath = "event_test.kif";
    insertLegacyOrphan(orphanSfen);
    fs.writeFileSync(
      path.join(tempDir, kifPath),
      "先手：A\n後手：B\n手数----指手----\n1 ７六歩(77)\n",
    );

    onKifuFileEvent("add", tempDir, kifPath);
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(hasPosition(orphanSfen)).toBe(true);

    await syncKifuDirectory(tempDir);

    expect(hasPosition(orphanSfen)).toBe(false);
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

  it("backfills strategy fields when the pipeline version changes without rebuilding positions", async () => {
    const kifPath = "strategy-backfill.kif";
    fs.writeFileSync(
      path.join(tempDir, kifPath),
      "戦型：角換わり\n手数----指手----\n1 ７六歩(77)\n",
    );
    await syncKifuDirectory(tempDir);
    const before = getKifuFileByPath(kifPath);
    const testDb = new DatabaseSync(path.join(dbDir, "kifu_index.db"));
    try {
      testDb
        .prepare(
          `UPDATE kifu_files
           SET strategy = NULL,
               strategy_source = NULL,
               strategy_classifier_version = NULL,
               strategy_index_version = ?
           WHERE file_path = ?`,
        )
        .run(STRATEGY_INDEX_VERSION - 1, kifPath);
    } finally {
      testDb.close();
    }

    await syncKifuDirectory(tempDir);
    const after = getKifuFileByPath(kifPath);
    expect(after?.strategy).toBe("角換わり");
    expect(after?.strategy_index_version).toBe(STRATEGY_INDEX_VERSION);
    expect(after?.indexed_at).toBeGreaterThanOrEqual(before!.indexed_at);
  });

  it("should sync many files without blocking (non-blocking loop check)", async () => {
    // Create 110 dummy files to exceed the 100-item yield threshold
    for (let i = 0; i < 110; i++) {
      fs.writeFileSync(path.join(tempDir, `test_${i}.kif`), `手数----指手----\n1 ７六歩(77)\n`);
    }

    await syncKifuDirectory(tempDir);

    expect(getKifuCount()).toBe(110);
    const status = getSyncStatus();
    expect(status.total).toBe(110);
    expect(status.indexed).toBe(110);
  });
});
