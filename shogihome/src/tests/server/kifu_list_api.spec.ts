import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { requestApp } from "./honoRequest";

const { SERVER_PORT, tempKifuDir } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const port = 8400 + Math.floor(Math.random() * 100);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-kifu-api-"));
  process.env.PORT = port.toString();
  process.env.KIFU_DIR = dir;
  process.env.KIFU_UPLOAD_MAX_MB = "1";
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

vi.mock("@/server/database/kifu_index.js", () => kifuIndexMock);
vi.mock("@/server/database/sqlite.js", () => sqliteMock);
vi.mock("@/server/kifu_index/sync.js", () => kifuIndexSyncMock);

import { app } from "@/server/main";

const host = `localhost:${SERVER_PORT}`;

describe("API: /api/kifu", () => {
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

    const response = await requestApp(app, "GET", "/api/kifu/list?reload=true", { host });

    expect(response.status).toBe(200);
    const body = response.body;
    expect(body).toHaveLength(2);
    expect(body).toContainEqual({ name: "subdir", path: "subdir", isDirectory: true });
    expect(body).toContainEqual({ name: "root.kif", path: "root.kif", isDirectory: false });
  });

  it("lists existing directories independently of their contents", async () => {
    fs.mkdirSync(path.join(tempKifuDir, "empty"));
    fs.mkdirSync(path.join(tempKifuDir, "books"));
    fs.writeFileSync(path.join(tempKifuDir, "books", "book.db"), "book");

    const response = await requestApp(app, "GET", "/api/kifu/directories", { host });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      path: "",
      directories: [
        { name: "books", path: "books" },
        { name: "empty", path: "empty" },
      ],
    });
  });

  it("uploads binary files to an existing directory", async () => {
    fs.mkdirSync(path.join(tempKifuDir, "books"));
    const data = new Uint8Array([0, 1, 2, 255]);

    const response = await requestApp(
      app,
      "POST",
      "/api/kifu/upload?path=books%2Fsample.db&overwrite=false",
      {
        host,
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
      },
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      path: "books/sample.db",
      kind: "book",
      size: 4,
      overwritten: false,
    });
    expect(fs.readFileSync(path.join(tempKifuDir, "books", "sample.db"))).toEqual(
      Buffer.from(data),
    );
  });

  it("reports conflicts and only overwrites when explicitly requested", async () => {
    fs.writeFileSync(path.join(tempKifuDir, "game.kif"), "old");

    const conflict = await requestApp(
      app,
      "POST",
      "/api/kifu/upload?path=game.kif&overwrite=false",
      { host, body: "new" },
    );
    expect(conflict.status).toBe(409);
    expect(fs.readFileSync(path.join(tempKifuDir, "game.kif"), "utf8")).toBe("old");

    const overwritten = await requestApp(
      app,
      "POST",
      "/api/kifu/upload?path=game.kif&overwrite=true",
      { host, body: "new" },
    );
    expect(overwritten.status).toBe(200);
    expect(overwritten.body.overwritten).toBe(true);
    expect(fs.readFileSync(path.join(tempKifuDir, "game.kif"), "utf8")).toBe("new");
  });

  it("rejects unsupported files and missing destination directories", async () => {
    const unsupported = await requestApp(app, "POST", "/api/kifu/upload?path=notes.txt", {
      host,
      body: "text",
    });
    expect(unsupported.status).toBe(403);

    const missingDirectory = await requestApp(
      app,
      "POST",
      "/api/kifu/upload?path=missing%2Fgame.kif",
      { host, body: "kifu" },
    );
    expect(missingDirectory.status).toBe(404);
  });

  it("rejects empty uploads", async () => {
    const response = await requestApp(app, "POST", "/api/kifu/upload?path=empty.sfen", {
      host,
      body: new Uint8Array(),
    });

    expect(response.status).toBe(400);
    expect(fs.existsSync(path.join(tempKifuDir, "empty.sfen"))).toBe(false);
  });

  it("rejects uploads larger than the configured limit", async () => {
    const response = await requestApp(app, "POST", "/api/kifu/upload?path=large.kif", {
      host,
      headers: { "Content-Length": String(1024 * 1024 + 1) },
      body: "small body",
    });

    expect(response.status).toBe(413);
    expect(fs.existsSync(path.join(tempKifuDir, "large.kif"))).toBe(false);
  });

  it("enforces the upload limit while streaming and removes temporary data", async () => {
    const response = await requestApp(app, "POST", "/api/kifu/upload?path=large.kif", {
      host,
      headers: { "Content-Length": "1" },
      body: new Uint8Array(1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(fs.readdirSync(tempKifuDir)).toEqual([]);
  });

  it("should return entries in a specific directory", async () => {
    fs.mkdirSync(path.join(tempKifuDir, "level1"));
    fs.writeFileSync(path.join(tempKifuDir, "level1", "file1.kif"), "test");
    fs.mkdirSync(path.join(tempKifuDir, "level1", "level2"));
    fs.writeFileSync(path.join(tempKifuDir, "level1", "level2", "file2.kif"), "test");

    const response = await requestApp(app, "GET", "/api/kifu/list?reload=true&dir=level1", {
      host,
    });

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
    const response = await requestApp(
      app,
      "GET",
      `/api/kifu/list?reload=true&dir=${encodeURIComponent("../secret")}`,
      { host },
    );

    expect(response.status).toBe(400);
    expect(response.textBody).toContain("invalid dir");
  });

  it("should sort directories first then by name", async () => {
    fs.writeFileSync(path.join(tempKifuDir, "b.kif"), "test");
    fs.writeFileSync(path.join(tempKifuDir, "a.kif"), "test");
    fs.mkdirSync(path.join(tempKifuDir, "z_folder"));
    fs.writeFileSync(path.join(tempKifuDir, "z_folder", "dummy.kif"), "test");
    fs.mkdirSync(path.join(tempKifuDir, "m_folder"));
    fs.writeFileSync(path.join(tempKifuDir, "m_folder", "dummy.kif"), "test");

    const response = await requestApp(app, "GET", "/api/kifu/list?reload=true", { host });

    expect(response.status).toBe(200);
    const body = response.body;
    expect(body[0].name).toBe("m_folder");
    expect(body[1].name).toBe("z_folder");
    expect(body[2].name).toBe("a.kif");
    expect(body[3].name).toBe("b.kif");
  });

  it("should return kifu files as binary content", async () => {
    fs.writeFileSync(path.join(tempKifuDir, "root.kif"), "test");

    const response = await requestApp(app, "GET", "/api/kifu/get?path=root.kif", { host });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.textBody).toBe("test");
  });
});
