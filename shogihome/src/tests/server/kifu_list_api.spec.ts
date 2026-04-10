import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";

const { SERVER_PORT, tempKifuDir } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const port = 8400 + Math.floor(Math.random() * 100);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-kifu-api-"));
  process.env.PORT = port.toString();
  process.env.KIFU_DIR = dir;
  return { SERVER_PORT: port, tempKifuDir: dir };
});

const kifuIndexMock = vi.hoisted(() => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getKifuCount: vi.fn(() => 0),
  searchKifu: vi.fn(() => []),
}));

const sqliteMock = vi.hoisted(() => ({
  initDatabase: vi.fn(),
  saveAnalysisResults: vi.fn(),
  getAnalysisResults: vi.fn(() => []),
  getAnalysisDBStats: vi.fn(() => []),
  deleteAnalysisResultsByEngine: vi.fn(),
  cleanupAnalysisResults: vi.fn(),
  deleteAnalysisResult: vi.fn(),
  exportAnalysisResultsByEngine: vi.fn(function* () {}),
}));

const kifuIndexSyncMock = vi.hoisted(() => ({
  syncKifuDirectory: vi.fn(),
  getSyncStatus: vi.fn(() => ({ total: 0, indexed: 0, isIndexing: false })),
  onKifuFileEvent: vi.fn(),
}));

vi.mock("@/background/database/kifu_index.js", () => kifuIndexMock);
vi.mock("@/background/database/sqlite.js", () => sqliteMock);
vi.mock("@/background/kifu_index/sync.js", () => kifuIndexSyncMock);

// eslint-disable-next-line no-restricted-imports
import { app } from "../../../server.js";

describe("API: /api/kifu/list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KIFU_DIR = tempKifuDir;
    // Cleanup files
    const files = fs.readdirSync(tempKifuDir);
    for (const file of files) {
      fs.rmSync(path.join(tempKifuDir, file), { recursive: true, force: true });
    }
  });

  afterAll(() => {
    fs.rmSync(tempKifuDir, { recursive: true, force: true });
  });

  it("should return root entries when dir is not specified", async () => {
    fs.writeFileSync(path.join(tempKifuDir, "root.kif"), "test");
    fs.mkdirSync(path.join(tempKifuDir, "subdir"));
    fs.writeFileSync(path.join(tempKifuDir, "subdir", "nested.kif"), "test");

    const response = await request(app)
      .get("/api/kifu/list?reload=true")
      .set("Host", `localhost:${SERVER_PORT}`);

    expect(response.status).toBe(200);
    const body = response.body;
    expect(body).toHaveLength(2);
    expect(body).toContainEqual({ name: "subdir", path: "subdir", isDirectory: true });
    expect(body).toContainEqual({ name: "root.kif", path: "root.kif", isDirectory: false });
  });

  it("should return entries in a specific directory", async () => {
    fs.mkdirSync(path.join(tempKifuDir, "level1"));
    fs.writeFileSync(path.join(tempKifuDir, "level1", "file1.kif"), "test");
    fs.mkdirSync(path.join(tempKifuDir, "level1", "level2"));
    fs.writeFileSync(path.join(tempKifuDir, "level1", "level2", "file2.kif"), "test");

    const response = await request(app)
      .get("/api/kifu/list?reload=true")
      .query({ dir: "level1" })
      .set("Host", `localhost:${SERVER_PORT}`);

    expect(response.status).toBe(200);
    const body = response.body;
    expect(body).toHaveLength(2);
    expect(body).toContainEqual({ name: "level2", path: "level1/level2", isDirectory: true });
    expect(body).toContainEqual({
      name: "file1.kif",
      path: "level1/file1.kif",
      isDirectory: false,
    });
  });

  it("should return 400 for path traversal attempts", async () => {
    const response = await request(app)
      .get("/api/kifu/list?reload=true")
      .query({ dir: "../secret" })
      .set("Host", `localhost:${SERVER_PORT}`);

    expect(response.status).toBe(400);
    expect(response.text).toContain("invalid dir");
  });

  it("should sort directories first then by name", async () => {
    fs.writeFileSync(path.join(tempKifuDir, "b.kif"), "test");
    fs.writeFileSync(path.join(tempKifuDir, "a.kif"), "test");
    fs.mkdirSync(path.join(tempKifuDir, "z_folder"));
    fs.writeFileSync(path.join(tempKifuDir, "z_folder", "dummy.kif"), "test");
    fs.mkdirSync(path.join(tempKifuDir, "m_folder"));
    fs.writeFileSync(path.join(tempKifuDir, "m_folder", "dummy.kif"), "test");

    const response = await request(app)
      .get("/api/kifu/list?reload=true")
      .set("Host", `localhost:${SERVER_PORT}`);

    expect(response.status).toBe(200);
    const body = response.body;
    expect(body[0].name).toBe("m_folder");
    expect(body[1].name).toBe("z_folder");
    expect(body[2].name).toBe("a.kif");
    expect(body[3].name).toBe("b.kif");
  });
});
