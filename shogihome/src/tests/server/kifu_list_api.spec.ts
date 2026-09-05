import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { SERVER_UPLOAD_TIMEOUT_MS } from "@/common/file/upload";
import { requestApp } from "./honoRequest";

const { SERVER_PORT, tempKifuDir, createServerSpy } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const http = await import("node:http");
  const port = 8400 + Math.floor(Math.random() * 100);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-kifu-api-"));
  process.env.PORT = port.toString();
  process.env.KIFU_DIR = dir;
  process.env.KIFU_UPLOAD_MAX_MB = "1";
  process.env.FILE_UPLOAD_MAX_CONCURRENCY = "1";
  return {
    SERVER_PORT: port,
    tempKifuDir: dir,
    createServerSpy: vi.spyOn(http.default, "createServer"),
  };
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

const httpServer = createServerSpy.mock.results[0].value as http.Server;
createServerSpy.mockRestore();
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

  it("allows the full upload timeout for HTTP request reception", () => {
    expect(httpServer.requestTimeout).toBe(SERVER_UPLOAD_TIMEOUT_MS);
  });

  it("cancels stalled input after a disk error and releases the upload slot", async () => {
    fs.writeFileSync(path.join(tempKifuDir, "failed.kif"), "old");
    const createWriteStream = fs.createWriteStream.bind(fs);
    const diskError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const streamSpy = vi
      .spyOn(fs, "createWriteStream")
      .mockImplementationOnce((filePath, options) => {
        const stream = createWriteStream(filePath, options);
        stream.once("open", () => stream.destroy(diskError));
        return stream;
      });
    const cancel = vi.fn();
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        input = controller;
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const request = requestApp(app, "POST", "/api/kifu/upload?path=failed.kif&overwrite=true", {
      host,
      body,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        request,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 500);
        }),
      ]);
      expect(cancel).toHaveBeenCalled();
      expect(response?.status).toBe(500);
      expect(fs.readdirSync(tempKifuDir)).toEqual(["failed.kif"]);
      expect(fs.readFileSync(path.join(tempKifuDir, "failed.kif"), "utf8")).toBe("old");

      const retry = await requestApp(app, "POST", "/api/kifu/upload?path=retry.kif", {
        host,
        body: "kifu",
      });
      expect(retry.status).toBe(201);
    } finally {
      clearTimeout(timer);
      if (!cancel.mock.calls.length) input.close();
      await request;
      streamSpy.mockRestore();
    }
  });

  it("cleans up an interrupted request without publishing partial data", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      pull(controller) {
        controller.error(new Error("client disconnected"));
      },
    });

    const response = await requestApp(app, "POST", "/api/kifu/upload?path=partial.kif", {
      host,
      body,
    });

    expect(response.status).toBe(500);
    expect(fs.readdirSync(tempKifuDir)).toEqual([]);
    const retry = await requestApp(app, "POST", "/api/kifu/upload?path=retry.kif", {
      host,
      body: "kifu",
    });
    expect(retry.status).toBe(201);
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

  it("creates and lists a directory that can receive a renamed upload", async () => {
    fs.mkdirSync(path.join(tempKifuDir, "games"));
    const created = await requestApp(app, "POST", "/api/kifu/directories", {
      host,
      json: { parent: "games", name: "2026" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ name: "2026", path: "games/2026" });

    const listed = await requestApp(app, "GET", "/api/kifu/directories?dir=games", { host });
    expect(listed.body.directories).toEqual([{ name: "2026", path: "games/2026" }]);
    const uploaded = await requestApp(app, "POST", "/api/kifu/upload?path=games/2026/renamed.kif", {
      host,
      body: "original bytes",
    });
    expect(uploaded.status).toBe(201);
    expect(fs.readFileSync(path.join(tempKifuDir, "games", "2026", "renamed.kif"), "utf8")).toBe(
      "original bytes",
    );
  });

  it("creates only one directory when requests race", async () => {
    const responses = await Promise.all(
      [0, 1].map(() =>
        requestApp(app, "POST", "/api/kifu/directories", {
          host,
          json: { parent: "", name: "new" },
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(fs.readdirSync(tempKifuDir)).toEqual(["new"]);
  });

  it("does not replace a file or symlink when creating a directory", async () => {
    fs.writeFileSync(path.join(tempKifuDir, "existing"), "original");
    fs.symlinkSync(path.join(tempKifuDir, "existing"), path.join(tempKifuDir, "linked"));
    for (const name of ["existing", "linked"]) {
      const response = await requestApp(app, "POST", "/api/kifu/directories", {
        host,
        json: { parent: "", name },
      });
      expect(response.status).toBe(409);
    }
    expect(fs.readFileSync(path.join(tempKifuDir, "existing"), "utf8")).toBe("original");
    expect(fs.lstatSync(path.join(tempKifuDir, "linked")).isSymbolicLink()).toBe(true);
  });

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "nested/new",
    "nested\\new",
    ".hidden",
    "CON",
    "new\u0000",
    "a".repeat(251),
  ])("rejects invalid directory name %j", async (name) => {
    const response = await requestApp(app, "POST", "/api/kifu/directories", {
      host,
      json: { parent: "", name },
    });
    expect(response.status).toBe(400);
    expect(fs.readdirSync(tempKifuDir)).toEqual([]);
  });

  it.each([{}, { parent: "" }, { parent: 1, name: "new" }, { parent: "", name: 1 }])(
    "rejects malformed directory creation body %j",
    async (json) => {
      const response = await requestApp(app, "POST", "/api/kifu/directories", { host, json });
      expect(response.status).toBe(400);
    },
  );

  it.each(["missing", "../escape", "/absolute", "a/../b"])(
    "rejects invalid or missing parent %j without creating ancestors",
    async (parent) => {
      const response = await requestApp(app, "POST", "/api/kifu/directories", {
        host,
        json: { parent, name: "new" },
      });
      expect(response.status).toBe(400);
      expect(fs.readdirSync(tempKifuDir)).toEqual([]);
    },
  );

  it("rejects a symlink parent", async () => {
    fs.mkdirSync(path.join(tempKifuDir, "real"));
    fs.symlinkSync(path.join(tempKifuDir, "real"), path.join(tempKifuDir, "linked"), "dir");
    const response = await requestApp(app, "POST", "/api/kifu/directories", {
      host,
      json: { parent: "linked", name: "new" },
    });
    expect(response.status).toBe(400);
    expect(fs.readdirSync(path.join(tempKifuDir, "real"))).toEqual([]);
  });

  it("enforces the directory depth boundary", async () => {
    const parent = Array(9).fill("level").join("/");
    fs.mkdirSync(path.join(tempKifuDir, parent), { recursive: true });
    const allowed = await requestApp(app, "POST", "/api/kifu/directories", {
      host,
      json: { parent, name: "last" },
    });
    expect(allowed.status).toBe(201);
    const rejected = await requestApp(app, "POST", "/api/kifu/directories", {
      host,
      json: { parent: `${parent}/last`, name: "too-deep" },
    });
    expect(rejected.status).toBe(400);
    expect(fs.readdirSync(path.join(tempKifuDir, parent, "last"))).toEqual([]);
  });

  it("requires an allowed Origin to create a directory", async () => {
    const response = await requestApp(app, "POST", "/api/kifu/directories", {
      host,
      omitOrigin: true,
      json: { parent: "", name: "new" },
    });
    expect(response.status).toBe(403);
    expect(fs.readdirSync(tempKifuDir)).toEqual([]);
  });

  it.each([".kif", ".hidden.kif", "CON.kif", "nested\\game.kif", "a".repeat(247) + ".kif"])(
    "rejects unsafe upload file name %j",
    async (name) => {
      const response = await requestApp(
        app,
        "POST",
        `/api/kifu/upload?path=${encodeURIComponent(name)}`,
        {
          host,
          body: "kifu",
        },
      );
      expect(response.status).toBe(400);
      expect(fs.readdirSync(tempKifuDir)).toEqual([]);
    },
  );

  it("drains the request body before reporting an upload conflict", async () => {
    fs.writeFileSync(path.join(tempKifuDir, "conflict.db"), "old");
    let delivered = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      pull(controller) {
        delivered += 1;
        controller.close();
      },
      cancel,
    });

    const response = await requestApp(
      app,
      "POST",
      "/api/kifu/upload?path=conflict.db&overwrite=false",
      { host, body },
    );

    expect(response.status).toBe(409);
    expect(cancel).not.toHaveBeenCalled();
    expect(delivered).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(tempKifuDir, "conflict.db"), "utf8")).toBe("old");
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

  it("drains the request body before rejecting an oversized upload", async () => {
    let delivered = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      pull(controller) {
        delivered += 1;
        controller.close();
      },
      cancel,
    });

    const response = await requestApp(app, "POST", "/api/kifu/upload?path=large.kif", {
      host,
      headers: { "Content-Length": String(1024 * 1024 + 1) },
      body,
    });

    expect(response.status).toBe(413);
    expect(cancel).not.toHaveBeenCalled();
    expect(delivered).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tempKifuDir, "large.kif"))).toBe(false);
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
