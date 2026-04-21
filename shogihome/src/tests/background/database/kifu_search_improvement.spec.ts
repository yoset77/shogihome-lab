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

describe("background/database/kifu_index_search_improvement", () => {
  const testDataDir = path.join(__dirname, "test_kifu_data_improvement");

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

  function makeMetadata(
    filePath: string,
    black: string,
    white: string,
    event: string,
  ): Omit<KifuFileMetadata, "indexed_at"> {
    return {
      file_path: filePath,
      mtime: Date.now(),
      size: 1000,
      black_name: black,
      white_name: white,
      start_date: "2024/01/01",
      event: event,
    };
  }

  it("should perform AND search with multiple keywords", () => {
    upsertKifuFile(makeMetadata("test1.kif", "Habu", "Fujii", "Ryuo-sen"), []);
    upsertKifuFile(makeMetadata("test2.kif", "Habu", "Ito", "Meijin-sen"), []);
    upsertKifuFile(makeMetadata("test3.kif", "Sato", "Fujii", "Ryuo-sen"), []);

    // Single keyword
    expect(searchKifu({ keyword: "Habu" }).length).toBe(2);
    expect(searchKifu({ keyword: "Fujii" }).length).toBe(2);

    // AND search
    expect(searchKifu({ keyword: "Habu Fujii" }).length).toBe(1);
    expect(searchKifu({ keyword: "Habu Fujii" })[0].file_path).toBe("test1.kif");
    expect(searchKifu({ keyword: "Fujii Ryuo-sen" }).length).toBe(2);
    expect(searchKifu({ keyword: "Habu Ryuo-sen" }).length).toBe(1);
  });

  it("should search by player1 or player2", () => {
    upsertKifuFile(makeMetadata("test1.kif", "Habu", "Fujii", "Event"), []);

    expect(searchKifu({ player1: "Habu" }).length).toBe(1);
    expect(searchKifu({ player2: "Fujii" }).length).toBe(1);
    expect(searchKifu({ player1: "Fujii" }).length).toBe(1); // player1 matches either black or white
    expect(searchKifu({ player2: "Habu" }).length).toBe(1);
  });

  it("should search by both player1 and player2 without strict turn", () => {
    upsertKifuFile(makeMetadata("test1.kif", "Habu", "Fujii", "Event"), []);

    expect(searchKifu({ player1: "Habu", player2: "Fujii", isStrictTurn: false }).length).toBe(1);
    expect(searchKifu({ player1: "Fujii", player2: "Habu", isStrictTurn: false }).length).toBe(1);
    expect(searchKifu({ player1: "Habu", player2: "Ito", isStrictTurn: false }).length).toBe(0);
  });

  it("should search by both player1 and player2 with strict turn", () => {
    upsertKifuFile(makeMetadata("test1.kif", "Habu", "Fujii", "Event"), []);

    expect(searchKifu({ player1: "Habu", player2: "Fujii", isStrictTurn: true }).length).toBe(1);
    expect(searchKifu({ player1: "Fujii", player2: "Habu", isStrictTurn: true }).length).toBe(0);
  });

  it("should respect isStrictTurn even when only one player is specified", () => {
    upsertKifuFile(makeMetadata("test1.kif", "Habu", "Fujii", "Event"), []);

    // isStrictTurn is true: player1 must be Sente (black), player2 must be Gote (white)
    expect(searchKifu({ player1: "Habu", isStrictTurn: true }).length).toBe(1);
    expect(searchKifu({ player1: "Fujii", isStrictTurn: true }).length).toBe(0);
    expect(searchKifu({ player2: "Fujii", isStrictTurn: true }).length).toBe(1);
    expect(searchKifu({ player2: "Habu", isStrictTurn: true }).length).toBe(0);

    // isStrictTurn is false: player1/player2 can be either Sente or Gote
    expect(searchKifu({ player1: "Fujii", isStrictTurn: false }).length).toBe(1);
    expect(searchKifu({ player2: "Habu", isStrictTurn: false }).length).toBe(1);
  });
});
