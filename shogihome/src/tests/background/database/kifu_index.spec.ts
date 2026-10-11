import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  initDatabase,
  closeDatabase,
  upsertKifuFile,
  deleteKifuFile,
  getKifuFileByPath,
  searchKifu,
  getKifuSearchCount,
  getKifuSearchStatistics,
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
      expect(migratedDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally {
      migratedDb.close();
    }
  });

  it("keeps the index disabled when its schema version is newer", () => {
    closeDatabase();
    fs.rmSync(path.join(testDataDir, "kifu_index.db"), { force: true });
    const futureDb = new DatabaseSync(path.join(testDataDir, "kifu_index.db"));
    futureDb.exec("PRAGMA user_version = 3");
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

  it("keeps the first registered occurrence when the same position appears multiple times", () => {
    const positions = [
      { sfen_hash: 100n, sfen: "pos1", ply: 0 },
      { sfen_hash: 200n, sfen: "shared", ply: 10 },
      { sfen_hash: 300n, sfen: "pos3", ply: 15 },
      { sfen_hash: 200n, sfen: "shared", ply: 2 },
      { sfen_hash: 200n, sfen: "shared", ply: 50 },
    ];

    upsertKifuFile(makeMetadata("test1.kif"), positions);

    const results = searchKifu({ sfenHash: 200n, sfen: "shared" });
    expect(results.length).toBe(1);
    expect(results[0].matched_ply).toBe(10);
  });

  it("preserves unique position matches and ordering with pagination and hash collisions", () => {
    const positions = [
      { sfen_hash: 200n, sfen: "shared", ply: 10, next_move: "☗２五歩" },
      { sfen_hash: 200n, sfen: "shared", ply: 2, next_move: "☗５六歩" },
    ];
    for (const [filePath, startDate] of [
      ["older.kif", "2024/05/01"],
      ["latest.kif", "2024/05/03"],
      ["newer.kif", "2024/05/02"],
    ]) {
      upsertKifuFile({ ...makeMetadata(filePath), start_date: startDate }, positions);
    }
    upsertKifuFile(makeMetadata("collision.kif"), [{ sfen_hash: 200n, sfen: "other", ply: 0 }]);

    const query = { sfenHash: 200n, sfen: "shared" };
    const paths = ["latest.kif", "newer.kif", "older.kif"];
    const results = searchKifu(query);
    expect(results.map((row) => row.file_path)).toEqual(paths);
    for (const row of results) {
      expect(row).toMatchObject({ matched_ply: 10, matched_sfen: "shared", next_move: "☗２五歩" });
    }
    expect(searchKifu({ ...query, limit: 1, offset: 1 })).toEqual([results[1]]);
    expect(getKifuSearchCount(query)).toBe(3);
    expect(getKifuSearchFilePaths({ ...query, limit: 1, offset: 1 })).toEqual(paths);
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
    const statistics = getKifuSearchStatistics({ ...params, limit: 1, offset: 100 });
    expect(statistics.total).toBe(125);
    expect(statistics.strategies).toEqual([{ strategy: "unclassified", count: 125 }]);
    expect(statistics.players).toEqual([
      { name: "Player A", black: 125, white: 0, total: 125 },
      { name: "Player B", black: 0, white: 125, total: 125 },
    ]);
    expect(statistics.otherPlayers).toEqual({ black: 0, white: 0, total: 0 });
  });

  it.each([false, true])(
    "returns the top fifty players and omitted appearances across all matching files (position search: %s)",
    (isPositionSearch) => {
      for (let index = 59; index >= 0; index -= 1) {
        upsertKifuFile(
          {
            ...makeMetadata(`ranked-${index}.kif`),
            black_name: `Player ${index.toString().padStart(2, "0")}`,
            white_name: "Frequent",
            event: "Ranked",
          },
          [
            { sfen_hash: 100n, sfen: "shared", ply: 0, next_move: "☗７六歩" },
            { sfen_hash: 100n, sfen: "shared", ply: 4, next_move: "☗２六歩" },
          ],
        );
      }
      upsertKifuFile(makeMetadata("outside.kif"), [{ sfen_hash: 100n, sfen: "shared", ply: 0 }]);

      const statistics = getKifuSearchStatistics({
        keyword: "Ranked",
        ...(isPositionSearch ? { sfenHash: 100n, sfen: "shared" } : {}),
        limit: 1,
        offset: 100,
      });
      expect(statistics.total).toBe(60);
      expect(statistics.strategies).toEqual([{ strategy: "unclassified", count: 60 }]);
      expect(statistics.players).toEqual([
        { name: "Frequent", black: 0, white: 60, total: 60 },
        ...Array.from({ length: 49 }, (_, index) => ({
          name: `Player ${index.toString().padStart(2, "0")}`,
          black: 1,
          white: 0,
          total: 1,
        })),
      ]);
      expect(statistics.otherPlayers).toEqual({ black: 11, white: 0, total: 11 });
      expect(
        statistics.players.reduce((sum, row) => sum + row.total, 0) + statistics.otherPlayers.total,
      ).toBe(statistics.total * 2);
      if (isPositionSearch) {
        expect(statistics.nextMoves).toEqual([{ move: "☗７六歩", count: 60 }]);
      } else {
        expect(statistics.nextMoves).toBeUndefined();
      }
    },
  );

  it.each([0, 49, 50])("preserves player counts at the cap boundary for %i files", (fileCount) => {
    for (let index = 0; index < fileCount; index += 1) {
      upsertKifuFile(
        { ...makeMetadata(`boundary-${index}.kif`), black_name: `Player ${index}` },
        [],
      );
    }
    const statistics = getKifuSearchStatistics({});
    expect(statistics.players).toHaveLength(fileCount ? Math.min(fileCount + 1, 50) : 0);
    const omitted = Math.max(0, fileCount - 49);
    expect(statistics.otherPlayers).toEqual({ black: omitted, white: 0, total: omitted });
  });

  it("aggregates strategies and player appearances without merging names or missing metadata", () => {
    upsertKifuFile(
      { ...makeMetadata("classified.kif"), strategy: "角換わり", black_name: "A", white_name: "A" },
      [],
    );
    upsertKifuFile(
      {
        ...makeMetadata("other.kif"),
        strategy: "その他",
        black_name: "A 九段",
        white_name: undefined,
      },
      [],
    );
    upsertKifuFile(
      { ...makeMetadata("raw.kif"), strategy_raw: "未知の戦型", black_name: "", white_name: "A" },
      [],
    );
    upsertKifuFile({ ...makeMetadata("unknown.kif"), black_name: " ", white_name: "B" }, []);
    const statistics = getKifuSearchStatistics({});
    expect(statistics.total).toBe(4);
    expect(statistics.strategies).toEqual(
      expect.arrayContaining([
        { strategy: "角換わり", count: 1 },
        { strategy: "その他", count: 1 },
        { strategy: "raw-only", count: 1 },
        { strategy: "unclassified", count: 1 },
      ]),
    );
    expect(statistics.players).toEqual([
      { name: null, black: 2, white: 1, total: 3 },
      { name: "A", black: 1, white: 2, total: 3 },
      { name: "A 九段", black: 1, white: 0, total: 1 },
      { name: "B", black: 0, white: 1, total: 1 },
    ]);
    expect(statistics.otherPlayers).toEqual({ black: 0, white: 0, total: 0 });
    expect(getKifuSearchStatistics({ strategy: "unclassified" }).total).toBe(1);
    expect(getKifuSearchStatistics({ keyword: "not found" })).toMatchObject({
      total: 0,
      strategies: [],
      players: [],
    });
  });

  it("uses all combined search filters and counts repeated positions only once", () => {
    const metadata = {
      ...makeMetadata("matching.kif"),
      event: "Final",
      strategy: "角換わり" as const,
    };
    const positions = [
      { sfen_hash: 100n, sfen: "shared", ply: 4 },
      { sfen_hash: 100n, sfen: "shared", ply: 8 },
    ];
    upsertKifuFile(metadata, positions);
    upsertKifuFile({ ...metadata, file_path: "other.kif", white_name: "Other" }, positions);
    const query = {
      sfenHash: 100n,
      sfen: "shared",
      keyword: "Final",
      player1: "Player A",
      player2: "Player B",
      isStrictTurn: true,
      startDate: "2024/01",
      strategy: "角換わり" as const,
    };
    expect(getKifuSearchStatistics(query).total).toBe(getKifuSearchCount(query));
    expect(getKifuSearchStatistics(query)).toMatchObject({
      total: 1,
      strategies: [{ strategy: "角換わり", count: 1 }],
    });
  });

  it("aggregates the representative next move per file for position search", () => {
    upsertKifuFile(makeMetadata("mainline.kif"), [
      { sfen_hash: 100n, sfen: "shared", ply: 4, next_move: "☗２五歩" },
      // A repeated position does not add another next move for the same file.
      { sfen_hash: 100n, sfen: "shared", ply: 8, next_move: "☗２四歩" },
    ]);
    // Variation representatives are counted by move only.
    upsertKifuFile(makeMetadata("variation.kif"), [
      { sfen_hash: 100n, sfen: "shared", ply: 2, next_move: "☗２五歩", is_variation: true },
    ]);
    upsertKifuFile(makeMetadata("finished.kif"), [
      { sfen_hash: 100n, sfen: "shared", ply: 6, next_move: "" },
    ]);
    upsertKifuFile(makeMetadata("unavailable.kif"), [{ sfen_hash: 100n, sfen: "shared", ply: 1 }]);
    upsertKifuFile(makeMetadata("other.kif"), [
      { sfen_hash: 200n, sfen: "other", ply: 3, next_move: "☗５六歩" },
    ]);

    const statistics = getKifuSearchStatistics({ sfenHash: 100n, sfen: "shared" });
    expect(statistics.total).toBe(4);
    expect(statistics.nextMoves).toEqual([
      { move: "☗２五歩", count: 2 },
      { move: "", count: 1 },
      { move: null, count: 1 },
    ]);
    expect(statistics.nextMoves?.reduce((sum, row) => sum + row.count, 0)).toBe(statistics.total);
    expect(getKifuSearchStatistics({}).nextMoves).toBeUndefined();
  });

  it.each([false, true])(
    "preserves the statistics error when rolling back (rollback failure: %s)",
    (rollbackFails) => {
      const statisticsError = new Error("statistics query failed");
      const rollbackError = new Error("rollback failed");
      const originalExec = DatabaseSync.prototype.exec;
      const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ) {
        if (sql === "ROLLBACK" && rollbackFails) throw rollbackError;
        return originalExec.call(this, sql);
      });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementationOnce(() => {
        throw statisticsError;
      });

      try {
        expect(() => getKifuSearchStatistics({})).toThrow(statisticsError);
        expect(exec).toHaveBeenCalledWith("ROLLBACK");
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
    },
  );

  it("migrates version one without discarding strategies and distinguishes unavailable next moves", () => {
    upsertKifuFile(
      {
        ...makeMetadata("legacy.kif"),
        strategy: "角換わり",
        strategy_raw: "角換わり",
        strategy_index_version: 1,
      },
      [{ sfen_hash: 100n, sfen: "shared", ply: 4 }],
    );
    closeDatabase();
    const legacy = new DatabaseSync(path.join(testDataDir, "kifu_index.db"));
    legacy.exec(`
      ALTER TABLE kifu_files DROP COLUMN position_index_version;
      ALTER TABLE kifu_positions DROP COLUMN next_move;
      ALTER TABLE kifu_positions DROP COLUMN is_variation;
      PRAGMA user_version = 1;
    `);
    legacy.close();
    initDatabase(testDataDir);
    expect(getKifuFileByPath("legacy.kif")).toMatchObject({
      strategy: "角換わり",
      strategy_index_version: 1,
      position_index_version: 0,
    });
    expect(searchKifu({ sfenHash: 100n, sfen: "shared" })[0].next_move).toBeNull();
    upsertKifuFile(makeMetadata("ending.kif"), [
      { sfen_hash: 100n, sfen: "shared", ply: 4, next_move: "" },
    ]);
    expect(
      searchKifu({ sfenHash: 100n, sfen: "shared" }).find((row) => row.file_path === "ending.kif")
        ?.next_move,
    ).toBe("");
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
