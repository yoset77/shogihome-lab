import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseAndIndexFile } from "@/background/kifu_index/engine.js";
import {
  initDatabase,
  closeDatabase,
  upsertKifuFile,
  searchKifu,
} from "@/background/database/kifu_index.js";
import { encodeText } from "@/common/helpers/encode.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("background/kifu_index/engine", () => {
  let tempDir: string;
  let dbDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-engine-"));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-db-"));
    initDatabase(dbDir);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("should parse KIF file with metadata and branches", async () => {
    const kifContent = [
      "#KIF1.0",
      "対局ID：123",
      "開始日時：2023/10/01 10:00:00",
      "棋戦：テスト棋戦",
      "先手：先手太郎",
      "後手：後手次郎",
      "手合割：平手",
      "先手番",
      "手数----指手----消費時間--",
      "   1 ７六歩(77)   ( 0:01/00:00:01)",
      "   2 ３四歩(33)   ( 0:02/00:00:02)",
      "   3 ５八金右(49)   ( 0:03/00:00:03)",
      "",
      "変化：3手",
      "   3 ７八金(69)   ( 0:01/00:00:01)",
    ].join("\r\n");
    const kifPath = "test.kif";
    fs.writeFileSync(path.join(tempDir, kifPath), encodeText(kifContent, "SJIS"));

    const result = await parseAndIndexFile(tempDir, kifPath);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.metadata.black_name).toBe("先手太郎");
    expect(result.metadata.white_name).toBe("後手次郎");
    expect(result.metadata.start_date).toBe("2023/10/01");
    expect(result.metadata.event).toBe("テスト棋戦");

    // ply 0 (initial), 1 (76歩), 2 (34歩), 3 (26歩), 3-branch (78金)
    // Total 5 positions
    expect(result.positions).toHaveLength(5);

    // Check initial position (ply 0)
    expect(result.positions[0].ply).toBe(0);
    expect(result.positions[0].sfen).toBe(
      "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -",
    );

    // Check that we have two ply 3 positions
    const ply3Positions = result.positions.filter((p) => p.ply === 3);
    expect(ply3Positions).toHaveLength(2);
  });

  it("should parse KIF file with handicap names", async () => {
    const kifContent = [
      "#KIF1.0",
      "下手：下手太郎",
      "上手：上手次郎",
      "手合割：二枚落ち",
      "上手番",
      "手数----指手----消費時間--",
      "   1 ６二銀(71)   ( 0:01/00:00:01)",
    ].join("\r\n");
    const kifPath = "handicap.kif";
    fs.writeFileSync(path.join(tempDir, kifPath), encodeText(kifContent, "SJIS"));

    const result = await parseAndIndexFile(tempDir, kifPath);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.metadata.black_name).toBe("下手太郎");
    expect(result.metadata.white_name).toBe("上手次郎");
  });

  it("should index and search by position", async () => {
    const kifContent =
      "手合割：平手\n先手番\n手数----指手----消費時間--\n 1 ７g７f(76)\n 2 ３c３d(33)\n";
    const kifPath = "test.kif";
    fs.writeFileSync(path.join(tempDir, kifPath), kifContent);

    const result = await parseAndIndexFile(tempDir, kifPath);
    expect(result).not.toBeNull();
    if (!result) return;

    upsertKifuFile(result.metadata, result.positions);

    // Search for 7g7f 3c3d position
    const targetPos = result.positions[2]; // ply 2
    const searchResult = searchKifu({
      sfenHash: targetPos.sfen_hash,
      sfen: targetPos.sfen,
    });

    expect(searchResult).toHaveLength(1);
    expect(searchResult[0].file_path).toBe(kifPath);
  });

  it("should search by keyword", async () => {
    const kifContent =
      "先手：羽生善治\n後手：藤井聡太\n棋戦：竜王戦\n手合割：平手\n先手番\n手数----指手----\n 1 ７g７f(76)\n";
    const kifPath = "habu_fujii.kif";
    fs.writeFileSync(path.join(tempDir, kifPath), kifContent);

    const result = await parseAndIndexFile(tempDir, kifPath);
    if (!result) return;
    upsertKifuFile(result.metadata, result.positions);

    const search1 = searchKifu({ keyword: "羽生" });
    expect(search1).toHaveLength(1);
    expect(search1[0].black_name).toBe("羽生善治");

    const search2 = searchKifu({ keyword: "竜王" });
    expect(search2).toHaveLength(1);
    expect(search2[0].event).toBe("竜王戦");

    const search3 = searchKifu({ keyword: "藤井" });
    expect(search3).toHaveLength(1);
    expect(search3[0].white_name).toBe("藤井聡太");

    const search4 = searchKifu({ keyword: "存在しない" });
    expect(search4).toHaveLength(0);
  });
});
