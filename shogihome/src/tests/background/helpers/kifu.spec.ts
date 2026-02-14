import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getKifuList, resolveKifuPath } from "@/background/helpers/kifu";
import fs from "fs";
import path from "path";
import os from "os";

describe("background/helpers/kifu", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-"));
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

  it("resolveKifuPath security and Japanese characters", () => {
    const relPath = path.join("subdir", "棋譜.kif");
    const result = resolveKifuPath(tempDir, relPath);
    expect(result).toBe(path.resolve(tempDir, relPath));

    // Path traversal attempt
    const maliciousPath = "../../etc/passwd";
    const result2 = resolveKifuPath(tempDir, maliciousPath);
    expect(result2).toBeNull();

    // Null/Empty path
    expect(resolveKifuPath(tempDir, "")).toBeNull();
  });
});
