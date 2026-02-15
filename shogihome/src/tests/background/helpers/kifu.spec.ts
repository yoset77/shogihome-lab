import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getKifuList, resolveKifuPath, clearKifuListCache } from "@/background/helpers/kifu";
import fs from "fs";
import path from "path";
import os from "os";

describe("background/helpers/kifu", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-"));
    clearKifuListCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("getKifuList recursive and filtered", async () => {
    // Create dummy files
    fs.mkdirSync(path.join(tempDir, "subdir"));
    fs.mkdirSync(path.join(tempDir, "日本語ディレクトリ"));
    fs.writeFileSync(path.join(tempDir, "test1.kif"), "test");
    fs.writeFileSync(path.join(tempDir, "test2.txt"), "test");
    fs.writeFileSync(path.join(tempDir, "subdir", "test3.csa"), "test");
    fs.writeFileSync(path.join(tempDir, "日本語ディレクトリ", "棋譜.jkf"), "test");

    const list = await getKifuList(tempDir);
    expect(list).toHaveLength(3);
    expect(list).toContain("test1.kif");
    expect(list).toContain(path.join("subdir", "test3.csa"));
    expect(list).toContain(path.join("日本語ディレクトリ", "棋譜.jkf"));
    expect(list).not.toContain("test2.txt");
  });

  it("getKifuList respects depth limit", async () => {
    // Create very deep directory
    let currentDir = tempDir;
    for (let i = 1; i <= 12; i++) {
      currentDir = path.join(currentDir, `level${i}`);
      fs.mkdirSync(currentDir);
      fs.writeFileSync(path.join(currentDir, `test${i}.kif`), "test");
    }

    const list = await getKifuList(tempDir);
    // MAX_DEPTH is 10, so level 1 to 11 should be included?
    // Wait, if depth starts at 0 (baseDir):
    // baseDir (0) -> level1 (1) -> level2 (2) -> ... -> level10 (10) -> level11 (11)
    // If walk(level11, 11) is called, it returns immediately.
    // So level11's files and subdirectories are NOT processed.
    // Thus files in level1 to level10 should be found.
    expect(list).toHaveLength(10);
    for (let i = 1; i <= 10; i++) {
      const expectedPath = Array.from({ length: i }, (_, k) => `level${k + 1}`).join(path.sep);
      expect(list).toContain(path.join(expectedPath, `test${i}.kif`));
    }
    expect(list).not.toContain(
      path.join(
        "level1",
        "level2",
        "level3",
        "level4",
        "level5",
        "level6",
        "level7",
        "level8",
        "level9",
        "level10",
        "level11",
        "test11.kif",
      ),
    );
  });

  it("resolveKifuPath security and Japanese characters", () => {
    const relPath = path.join("subdir", "棋譜.kif");
    const result = resolveKifuPath(tempDir, relPath);
    expect(result).toBe(path.resolve(tempDir, relPath));

    // Path traversal attempt
    const maliciousPath = "../../etc/passwd";
    const result2 = resolveKifuPath(tempDir, maliciousPath);
    expect(result2).toBeNull();

    // Unsupported extension
    const maliciousPath3 = "test.txt";
    const result3 = resolveKifuPath(tempDir, maliciousPath3);
    expect(result3).toBeNull();

    // Null/Empty path
    expect(resolveKifuPath(tempDir, "")).toBeNull();
  });

  it("resolveKifuPath rejects adjacent directory traversal", () => {
    // 同じプレフィックスを持つ隣接ディレクトリへの攻撃（startsWith バグの再現）
    const baseDir = tempDir; // 例: /tmp/shogihome-test-abc
    const adjacent = `../${path.basename(tempDir)}-evil/secret.kif`;
    expect(resolveKifuPath(baseDir, adjacent)).toBeNull();
  });

  it("resolveKifuPath rejects array-like path", () => {
    // typeof チェックの検証
    // @ts-expect-error: intentionally passing non-string
    expect(resolveKifuPath(tempDir, ["a", "b"])).toBeNull();
  });

  it("resolveKifuPath respects depth limit", () => {
    // 11 levels deep (10 levels of directories + 1 file) is allowed
    const validParts = Array.from({ length: 10 }, (_, i) => `${i}`);
    const validPath = path.join(...validParts, "file.kifu");
    expect(resolveKifuPath(tempDir, validPath)).not.toBeNull();

    // 12 levels deep is denied
    const invalidParts = Array.from({ length: 11 }, (_, i) => `${i}`);
    const invalidPath = path.join(...invalidParts, "file.kifu");
    expect(resolveKifuPath(tempDir, invalidPath)).toBeNull();
  });

  it("caching logic", async () => {
    fs.writeFileSync(path.join(tempDir, "test1.kif"), "test");
    const list1 = await getKifuList(tempDir);
    expect(list1).toHaveLength(1);

    // Add another file without clearing cache
    fs.writeFileSync(path.join(tempDir, "test2.kif"), "test");
    const list2 = await getKifuList(tempDir);
    expect(list2).toHaveLength(1); // Should still be 1 due to cache
    expect(list2).toBe(list1); // Should be the exact same array instance

    // Clear cache
    clearKifuListCache();
    const list3 = await getKifuList(tempDir);
    expect(list3).toHaveLength(2); // Now it should find both
    expect(list3).not.toBe(list1);
  });
});
