import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  initDatabase,
  saveAnalysisResults,
  getAnalysisResults,
  closeDatabase,
} from "@/background/database/sqlite.js";
import { USIInfoCommand } from "@/common/game/usi.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

describe("background/database/sqlite", () => {
  const testDataDir = path.join(__dirname, "test_data");

  beforeEach(() => {
    if (fs.existsSync(testDataDir)) {
      try {
        fs.rmSync(testDataDir, { recursive: true, force: true });
      } catch (e) {
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
      } catch (e) {
        // Windows file locking might still cause issues occasionally, safe to ignore during teardown
      }
    }
  });

  it("should save analysis results and update when depth is higher", () => {
    const infos = new Map<number, USIInfoCommand>();
    infos.set(1, { depth: 10, scoreCP: 300, pv: ["7g7f"] });

    saveAnalysisResults(12345n, "test sfen 1", "test-engine", "Test Engine v1", infos);

    const dbPath = path.join(testDataDir, "analysis.db");
    const db = new DatabaseSync(dbPath);

    interface AnalysisResultRow {
      depth: number;
      score_cp: number;
    }

    const rows = db
      .prepare("SELECT * FROM analysis_results")
      .all() as unknown as AnalysisResultRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].depth).toBe(10);
    expect(rows[0].score_cp).toBe(300);

    // Save with higher depth
    infos.set(1, { depth: 12, scoreCP: 350, pv: ["7g7f", "3c3d"] });
    saveAnalysisResults(12345n, "test sfen 1", "test-engine", "Test Engine v1", infos);

    const rows2 = db
      .prepare("SELECT * FROM analysis_results")
      .all() as unknown as AnalysisResultRow[];
    expect(rows2.length).toBe(1);
    expect(rows2[0].depth).toBe(12);
    expect(rows2[0].score_cp).toBe(350);

    // Save with lower depth (should not update)
    infos.set(1, { depth: 8, scoreCP: 200, pv: ["7g7f"] });
    saveAnalysisResults(12345n, "test sfen 1", "test-engine", "Test Engine v1", infos);

    const rows3 = db
      .prepare("SELECT * FROM analysis_results")
      .all() as unknown as AnalysisResultRow[];
    expect(rows3.length).toBe(1);
    expect(rows3[0].depth).toBe(12); // remains 12

    db.close();
  });

  it("should handle multiple PVs", () => {
    const infos = new Map<number, USIInfoCommand>();
    infos.set(1, { depth: 15, scoreCP: 400, pv: ["7g7f"] });
    infos.set(2, { depth: 14, scoreCP: 200, pv: ["2g2f"] });

    saveAnalysisResults(67890n, "test sfen 2", "test-engine", "Test Engine v1", infos);

    const dbPath = path.join(testDataDir, "analysis.db");
    const db = new DatabaseSync(dbPath);

    interface MultiPVRow {
      multipv: number;
      depth: number;
    }

    const rows = db
      .prepare("SELECT * FROM analysis_results ORDER BY multipv")
      .all() as unknown as MultiPVRow[];

    expect(rows.length).toBe(2);
    expect(rows[0].multipv).toBe(1);
    expect(rows[0].depth).toBe(15);
    expect(rows[1].multipv).toBe(2);
    expect(rows[1].depth).toBe(14);

    db.close();
  });

  it("should handle hash collisions by verifying SFEN string", () => {
    const infos1 = new Map<number, USIInfoCommand>();
    infos1.set(1, { depth: 10, scoreCP: 100, pv: ["7g7f"] });

    const infos2 = new Map<number, USIInfoCommand>();
    infos2.set(1, { depth: 10, scoreCP: 200, pv: ["2g2f"] });

    const sharedHash = 99999n;

    // Save two different positions with the same hash
    saveAnalysisResults(sharedHash, "sfen A", "engine-1", "Engine 1", infos1);
    saveAnalysisResults(sharedHash, "sfen B", "engine-1", "Engine 1", infos2);

    const resultsA = getAnalysisResults(sharedHash, "sfen A");
    const resultsB = getAnalysisResults(sharedHash, "sfen B");

    expect(resultsA.length).toBe(1);
    expect(resultsA[0].score_cp).toBe(100);

    expect(resultsB.length).toBe(1);
    expect(resultsB[0].score_cp).toBe(200);

    const resultsC = getAnalysisResults(sharedHash, "sfen C");
    expect(resultsC.length).toBe(0);
  });

  it("should enforce foreign key constraints", () => {
    const dbPath = path.join(testDataDir, "analysis.db");
    const db = new DatabaseSync(dbPath);

    // Try to insert a result with non-existent position/engine ID
    // Note: DatabaseSync might throw or fail silently depending on configuration,
    // but with foreign_keys = ON, it should fail.
    expect(() => {
      db.prepare(
        `
        INSERT INTO analysis_results (position_id, engine_id, multipv, depth, updated_at)
        VALUES (999, 999, 1, 10, 0)
      `,
      ).run();
    }).toThrow();

    db.close();
  });
});
