import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  initDatabase,
  closeDatabase,
  upsertKifuFile,
  deleteKifuFile,
  getKifuFileByPath,
  searchKifu,
  getKifuSearchCount,
  getKifuSearchFilePaths,
  getKifuCount,
  updateKifuFileStrategy,
  KifuFileMetadata,
} from "@/server/database/kifu_index";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

describe("background/database/kifu_index", () => {
  const testDataDir = path.join(__dirname, "test_kifu_data");

  beforeEach(() => {
    if (fs.existsSync(testDataDir)) {
      try {
        fs.rmSync(testDataDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    initDatabase(testDataDir);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(testDataDir)) {
      try {
        fs.rmSync(testDataDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function makeMetadata(filePath: string): Omit<KifuFileMetadata, "indexed_at"> {
    return {
      file_path: filePath,
      mtime: Date.now(),
      size: 1000,
      black_name: "Player A",
      white_name: "Player B",
      start_date: "2024/01/01",
      event: "Test Event",
    };
  }

  function getPositionCount(): number {
    const testDb = new DatabaseSync(path.join(testDataDir, "kifu_index.db"));
    try {
      const row = testDb.prepare("SELECT COUNT(*) AS count FROM positions").get() as {
        count: number;
      };
      return row.count;
    } finally {
      testDb.close();
    }
  }

  it("should return matched_ply when searching by position", () => {
    const positions = [
      { sfen_hash: 100n, sfen: "pos1", ply: 0 },
      { sfen_hash: 200n, sfen: "pos2", ply: 5 },
      { sfen_hash: 300n, sfen: "pos3", ply: 10 },
    ];

    upsertKifuFile(makeMetadata("test1.kif"), positions);

    const results = searchKifu({ sfenHash: 200n, sfen: "pos2" });
    expect(results.length).toBe(1);
    expect(results[0].file_path).toBe("test1.kif");
    expect(results[0].matched_ply).toBe(5);
  });

  it("stores internal inference metadata but exposes only the search-safe strategy fields", () => {
    const metadata = makeMetadata("strategy.kif");
    metadata.strategy = "角換わり";
    metadata.strategy_source = "inferred";
    metadata.strategy_score = 0.99;
    metadata.strategy_classifier_version = "v3-12-24-moves";
    metadata.strategy_index_version = 1;
    upsertKifuFile(metadata, [{ sfen_hash: 100n, sfen: "pos1", ply: 0 }]);

    const results = searchKifu({ strategy: "角換わり" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      strategy: "角換わり",
      strategy_source: "inferred",
    });
    expect(results[0]).not.toHaveProperty("strategy_score");
    expect(getKifuFileByPath("strategy.kif")).toMatchObject({
      strategy_score: 0.99,
      strategy_classifier_version: "v3-12-24-moves",
    });
    expect(getKifuSearchCount({ strategy: "相掛かり" })).toBe(0);
    expect(getKifuSearchFilePaths({ strategy: "角換わり" })).toEqual(["strategy.kif"]);
  });

  it("searches only files without strategy metadata as unclassified", () => {
    const unclassified = makeMetadata("unclassified.kif");
    const rawOnly = makeMetadata("raw-only.kif");
    rawOnly.strategy_raw = "未判定";
    const classified = makeMetadata("classified.kif");
    classified.strategy = "その他";

    upsertKifuFile(unclassified, []);
    upsertKifuFile(rawOnly, []);
    upsertKifuFile(classified, []);

    const results = searchKifu({ strategy: "unclassified" });
    expect(results.map((result) => result.file_path)).toEqual(["unclassified.kif"]);
    expect(getKifuSearchCount({ strategy: "unclassified" })).toBe(1);
    expect(getKifuSearchFilePaths({ strategy: "unclassified" })).toEqual(["unclassified.kif"]);
  });

  it("migrates an existing index and marks legacy rows for strategy backfill", () => {
    closeDatabase();
    fs.rmSync(path.join(testDataDir, "kifu_index.db"), { force: true });
    const legacyDb = new DatabaseSync(path.join(testDataDir, "kifu_index.db"));
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS kifu_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT UNIQUE NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        black_name TEXT,
        white_name TEXT,
        start_date TEXT,
        event TEXT,
        strategy TEXT,
        strategy_source TEXT,
        strategy_score REAL,
        strategy_model_version TEXT,
        strategy_alternatives TEXT,
        indexed_at INTEGER NOT NULL
      );
      INSERT INTO kifu_files (file_path, mtime, size, strategy, strategy_source, indexed_at)
      VALUES ('legacy.kif', 1, 1, 'experimental-label', 'experimental', 1);
    `);
    legacyDb.close();

    initDatabase(testDataDir);
    const migratedDb = new DatabaseSync(path.join(testDataDir, "kifu_index.db"));
    try {
      const row = migratedDb
        .prepare(
          "SELECT strategy, strategy_raw, strategy_source, strategy_score, strategy_classifier_version, strategy_index_version FROM kifu_files",
        )
        .get() as Record<string, null>;
      expect(row).toEqual({
        strategy: null,
        strategy_raw: null,
        strategy_source: null,
        strategy_score: null,
        strategy_classifier_version: null,
        strategy_index_version: 0,
      });
      expect(migratedDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      migratedDb.close();
    }
  });

  it("keeps the index disabled when its schema version is newer", () => {
    closeDatabase();
    fs.rmSync(path.join(testDataDir, "kifu_index.db"), { force: true });
    const futureDb = new DatabaseSync(path.join(testDataDir, "kifu_index.db"));
    futureDb.exec("PRAGMA user_version = 2");
    futureDb.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(() => initDatabase(testDataDir)).not.toThrow();
      expect(getKifuCount()).toBe(0);
      expect(searchKifu({})).toEqual([]);

      fs.rmSync(path.join(testDataDir, "kifu_index.db"), { force: true });
      initDatabase(testDataDir);
      upsertKifuFile(makeMetadata("recovered.kif"), []);
      expect(getKifuCount()).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("updates only strategy fields during a backfill", () => {
    const metadata = makeMetadata("backfill.kif");
    upsertKifuFile(metadata, [{ sfen_hash: 100n, sfen: "pos1", ply: 0 }]);
    updateKifuFileStrategy({
      ...metadata,
      strategy: "角換わり",
      strategy_source: "rule",
      strategy_classifier_version: "rules-v2",
      strategy_index_version: 1,
    });

    expect(searchKifu({ strategy: "角換わり" })).toHaveLength(1);
    expect(searchKifu({ sfenHash: 100n, sfen: "pos1" })).toHaveLength(1);
  });

  it("should return MIN(ply) when same position appears multiple times", () => {
    const positions = [
      { sfen_hash: 100n, sfen: "pos1", ply: 0 },
      { sfen_hash: 200n, sfen: "shared", ply: 10 },
      { sfen_hash: 300n, sfen: "pos3", ply: 15 },
      { sfen_hash: 200n, sfen: "shared", ply: 30 },
      { sfen_hash: 200n, sfen: "shared", ply: 50 },
    ];

    upsertKifuFile(makeMetadata("test1.kif"), positions);

    const results = searchKifu({ sfenHash: 200n, sfen: "shared" });
    expect(results.length).toBe(1);
    expect(results[0].matched_ply).toBe(10);
  });

  it("should not include matched_ply when searching by keyword only", () => {
    const positions = [
      { sfen_hash: 100n, sfen: "pos1", ply: 0 },
      { sfen_hash: 200n, sfen: "pos2", ply: 5 },
    ];

    upsertKifuFile(makeMetadata("test1.kif"), positions);

    const results = searchKifu({ keyword: "Player A" });
    expect(results.length).toBe(1);
    expect(results[0].file_path).toBe("test1.kif");
    expect(results[0].matched_ply).toBeUndefined();
  });

  it("should return matched_ply with combined position and keyword search", () => {
    const positions = [
      { sfen_hash: 100n, sfen: "pos1", ply: 0 },
      { sfen_hash: 200n, sfen: "pos2", ply: 7 },
    ];

    upsertKifuFile(makeMetadata("test1.kif"), positions);

    const results = searchKifu({ sfenHash: 200n, sfen: "pos2", keyword: "Player A" });
    expect(results.length).toBe(1);
    expect(results[0].matched_ply).toBe(7);
  });

  it("should return correct matched_ply for multiple kifu files", () => {
    const positions1 = [
      { sfen_hash: 100n, sfen: "pos1", ply: 0 },
      { sfen_hash: 200n, sfen: "shared", ply: 12 },
    ];
    const positions2 = [
      { sfen_hash: 100n, sfen: "pos1", ply: 0 },
      { sfen_hash: 200n, sfen: "shared", ply: 25 },
    ];

    upsertKifuFile(makeMetadata("test1.kif"), positions1);
    upsertKifuFile(makeMetadata("test2.kif"), positions2);

    const results = searchKifu({ sfenHash: 200n, sfen: "shared" });
    expect(results.length).toBe(2);

    const file1 = results.find((r) => r.file_path === "test1.kif");
    const file2 = results.find((r) => r.file_path === "test2.kif");
    expect(file1?.matched_ply).toBe(12);
    expect(file2?.matched_ply).toBe(25);
  });

  it("uses the same combined filters and ordering for search, count, and file paths", () => {
    const matchingPosition = { sfen_hash: 200n, sfen: "shared", ply: 7 };
    const matchingMetadata = {
      ...makeMetadata("matching.kif"),
      black_name: "Sato",
      white_name: "Tanaka",
      start_date: "2024/05/01",
      event: "Championship Final",
    };
    upsertKifuFile(matchingMetadata, [matchingPosition]);
    upsertKifuFile(
      {
        ...matchingMetadata,
        file_path: "newest.kif",
        start_date: "2024/05/02",
      },
      [matchingPosition],
    );
    upsertKifuFile(
      {
        ...matchingMetadata,
        file_path: "wrong-player.kif",
        black_name: "Tanaka",
        white_name: "Sato",
      },
      [matchingPosition],
    );
    upsertKifuFile(
      {
        ...matchingMetadata,
        file_path: "wrong-event.kif",
        event: "Qualifier",
      },
      [matchingPosition],
    );
    upsertKifuFile({ ...matchingMetadata, file_path: "wrong-position.kif" }, [
      { sfen_hash: 300n, sfen: "other", ply: 2 },
    ]);

    const params = {
      sfenHash: 200n,
      sfen: "shared",
      keyword: "Championship Final",
      player1: "Sato",
      player2: "Tanaka",
      isStrictTurn: true,
      startDate: "2024/05",
    };

    const results = searchKifu(params);
    expect(results.map((result) => result.file_path)).toEqual(["newest.kif", "matching.kif"]);
    expect(results.map((result) => result.matched_ply)).toEqual([7, 7]);
    expect(results.map((result) => result.matched_sfen)).toEqual(["shared", "shared"]);
    expect(getKifuSearchCount(params)).toBe(2);
    expect(getKifuSearchFilePaths(params)).toEqual(["newest.kif", "matching.kif"]);
  });

  it("returns every matching file path while preserving the default search limit", () => {
    for (let index = 0; index < 125; index += 1) {
      upsertKifuFile(
        {
          ...makeMetadata(`bulk-${index.toString().padStart(3, "0")}.kif`),
          start_date: "2024/06/01",
          event: "Bulk Export",
        },
        [],
      );
    }

    const params = { keyword: "Bulk Export" };
    const results = searchKifu(params);
    const filePaths = getKifuSearchFilePaths(params);

    expect(results).toHaveLength(100);
    expect(getKifuSearchCount(params)).toBe(125);
    expect(filePaths).toHaveLength(125);
    expect(results.map((result) => result.file_path)).toEqual(filePaths.slice(0, 100));
    expect(new Set(filePaths).size).toBe(125);
  });

  it("removes only positions orphaned by an upsert", () => {
    const sharedPosition = { sfen_hash: 100n, sfen: "shared", ply: 0 };
    upsertKifuFile(makeMetadata("test1.kif"), [
      sharedPosition,
      { sfen_hash: 200n, sfen: "obsolete", ply: 1 },
    ]);
    upsertKifuFile(makeMetadata("test2.kif"), [sharedPosition]);

    upsertKifuFile(makeMetadata("test1.kif"), [{ sfen_hash: 300n, sfen: "replacement", ply: 0 }]);

    expect(getPositionCount()).toBe(2);
    expect(searchKifu({ sfenHash: 100n, sfen: "shared" })).toHaveLength(1);
    expect(searchKifu({ sfenHash: 200n, sfen: "obsolete" })).toHaveLength(0);
  });

  it("removes only positions orphaned by a file deletion", () => {
    const sharedPosition = { sfen_hash: 100n, sfen: "shared", ply: 0 };
    upsertKifuFile(makeMetadata("test1.kif"), [
      sharedPosition,
      { sfen_hash: 200n, sfen: "unique", ply: 1 },
    ]);
    upsertKifuFile(makeMetadata("test2.kif"), [sharedPosition]);

    deleteKifuFile("test1.kif");

    expect(getPositionCount()).toBe(1);
    expect(searchKifu({ sfenHash: 100n, sfen: "shared" })).toHaveLength(1);

    deleteKifuFile("test2.kif");

    expect(getPositionCount()).toBe(0);
  });

  it("rolls back a file deletion when position cleanup fails", () => {
    upsertKifuFile(makeMetadata("test1.kif"), [{ sfen_hash: 100n, sfen: "unique", ply: 0 }]);
    const testDb = new DatabaseSync(path.join(testDataDir, "kifu_index.db"));
    try {
      testDb.exec(`
        CREATE TRIGGER fail_position_delete
        BEFORE DELETE ON positions
        BEGIN
          SELECT RAISE(ABORT, 'blocked position delete');
        END
      `);
    } finally {
      testDb.close();
    }

    expect(() => deleteKifuFile("test1.kif")).toThrow("blocked position delete");

    expect(getKifuFileByPath("test1.kif")).toBeDefined();
    expect(searchKifu({ sfenHash: 100n, sfen: "unique" })).toHaveLength(1);
  });
});
