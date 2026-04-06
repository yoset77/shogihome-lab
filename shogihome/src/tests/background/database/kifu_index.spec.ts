import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  initDatabase,
  closeDatabase,
  upsertKifuFile,
  searchKifu,
  KifuFileMetadata,
} from "@/background/database/kifu_index.js";
import fs from "node:fs";
import path from "node:path";

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
});
