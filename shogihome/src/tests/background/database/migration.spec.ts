import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  initDatabase,
  saveAnalysisResults,
  getAnalysisDBStats,
  getMigrationSummary,
  executeMigration,
  closeDatabase,
} from "@/background/database/sqlite.js";
import { USIInfoCommand } from "@/common/game/usi.js";
import fs from "node:fs";
import path from "node:path";

describe("background/database/migration", () => {
  const testDataDir = path.join(__dirname, "test_data_migration");

  beforeEach(() => {
    if (fs.existsSync(testDataDir)) {
      try {
        fs.rmSync(testDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
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
        /* ignore */
      }
    }
  });

  it("should generate correct migration summary and execute migration", () => {
    const infos1 = new Map<number, USIInfoCommand>();
    infos1.set(1, { depth: 10, scoreCP: 100, pv: ["7g7f"] });
    const infos2 = new Map<number, USIInfoCommand>();
    infos2.set(1, { depth: 20, scoreCP: 200, pv: ["2g2f"] });

    // Prepare data for two engines
    saveAnalysisResults(1n, "sfen 1", "engine-1", "Engine 1", infos1);
    saveAnalysisResults(2n, "sfen 2", "engine-2", "Engine 2", infos2);

    const keyMapping = new Map<string, string>();
    keyMapping.set("engine-1", "group-1");
    keyMapping.set("engine-2", "group-1");

    const nameMapping = new Map<string, string>();
    nameMapping.set("group-1", "Unified Group");

    // Test Dry-run
    const summary = getMigrationSummary(keyMapping, nameMapping);
    expect(summary.length).toBe(2);
    expect(summary.find((s) => s.sourceEngineKey === "engine-1")!.recordCount).toBe(1);
    expect(summary.find((s) => s.sourceEngineKey === "engine-2")!.recordCount).toBe(1);
    expect(summary.every((s) => s.targetEngineKey === "group-1")).toBe(true);
    expect(summary.every((s) => s.targetEngineName === "Unified Group")).toBe(true);

    // Test Execution
    executeMigration(keyMapping, nameMapping);

    const stats = getAnalysisDBStats();
    expect(stats.length).toBe(1);
    expect(stats[0].engine_key).toBe("group-1");
    expect(stats[0].name).toBe("Unified Group");
    expect(stats[0].record_count).toBe(2);
  });

  it("should keep the deepest result when merging engines", () => {
    const sharedSfen = "shared sfen";
    const sharedHash = 12345n;

    const infos1 = new Map<number, USIInfoCommand>();
    infos1.set(1, { depth: 15, scoreCP: 100, pv: ["7g7f"] });
    const infos2 = new Map<number, USIInfoCommand>();
    infos2.set(1, { depth: 25, scoreCP: 500, pv: ["7g7f", "3c3d"] });

    saveAnalysisResults(sharedHash, sharedSfen, "engine-1", "Engine 1", infos1);
    saveAnalysisResults(sharedHash, sharedSfen, "engine-2", "Engine 2", infos2);

    const keyMapping = new Map<string, string>();
    keyMapping.set("engine-1", "group-1");
    keyMapping.set("engine-2", "group-1");

    const nameMapping = new Map<string, string>();
    nameMapping.set("group-1", "Unified Group");

    executeMigration(keyMapping, nameMapping);

    const stats = getAnalysisDBStats();
    expect(stats.length).toBe(1);
    expect(stats[0].record_count).toBe(1);
    expect(stats[0].max_depth).toBe(25); // Deepest one remains
  });

  it("should handle engine name updates during migration", () => {
    const infos = new Map<number, USIInfoCommand>();
    infos.set(1, { depth: 10, scoreCP: 100, pv: ["7g7f"] });

    saveAnalysisResults(1n, "sfen 1", "engine-1", "Old Name", infos);

    const keyMapping = new Map<string, string>();
    keyMapping.set("engine-1", "group-1");

    const nameMapping = new Map<string, string>();
    nameMapping.set("group-1", "New Name");

    executeMigration(keyMapping, nameMapping);

    const stats = getAnalysisDBStats();
    expect(stats[0].name).toBe("New Name");
  });
});
