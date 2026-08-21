import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestApp } from "./honoRequest";

const SERVER_PORT = vi.hoisted(() => {
  return 8300 + Math.floor(Math.random() * 100);
});

vi.hoisted(() => {
  process.env.PORT = SERVER_PORT.toString();
  process.env.KIFU_DIR = "./data";
});

const kifuIndexMock = vi.hoisted(() => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getKifuCount: vi.fn(() => 0),
  searchKifu: vi.fn(() => [] as unknown[]),
  getKifuSearchCount: vi.fn(() => 0),
}));

const exportJobMock = vi.hoisted(() => ({
  startSfenExportJob: vi.fn(),
  getSfenExportJob: vi.fn(),
  cancelSfenExportJob: vi.fn(),
}));

const sqliteMock = vi.hoisted(() => ({
  initDatabase: vi.fn(),
  saveAnalysisResults: vi.fn(),
  getAnalysisResults: vi.fn(() => [] as unknown[]),
  getAnalysisDBStats: vi.fn(() => [] as unknown[]),
  deleteAnalysisResultsByEngine: vi.fn(),
  cleanupAnalysisResults: vi.fn(),
  deleteAnalysisResult: vi.fn(),
  exportAnalysisResultsByEngine: vi.fn(function* () {}),
}));

const sfenMock = vi.hoisted(() => ({
  getNormalizedSfenAndHash: vi.fn(),
}));

const kifuIndexSyncMock = vi.hoisted(() => ({
  syncKifuDirectory: vi.fn(),
  getSyncStatus: vi.fn(() => ({ total: 0, indexed: 0, isIndexing: false })),
  onKifuFileEvent: vi.fn(),
}));

vi.mock("@/server/database/kifu_index.js", () => kifuIndexMock);
vi.mock("@/server/database/sqlite.js", () => sqliteMock);
vi.mock("@/server/usi/sfen.js", () => sfenMock);
vi.mock("@/server/kifu_index/sync.js", () => kifuIndexSyncMock);
vi.mock("@/server/kifu_export/job.js", () => exportJobMock);

import { app } from "@/server/main";

const host = `localhost:${SERVER_PORT}`;

describe("Kifu search API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kifuIndexMock.searchKifu.mockReturnValue([]);
  });

  it("should return 400 for invalid sfen queries", async () => {
    sfenMock.getNormalizedSfenAndHash.mockReturnValue(null);

    const response = await requestApp(
      app,
      "GET",
      `/api/kifu/search?sfen=${encodeURIComponent("position invalid")}&keyword=test`,
      { host },
    );

    expect(response.status).toBe(400);
    expect(response.textBody).toContain("Invalid sfen");
    expect(kifuIndexMock.searchKifu).not.toHaveBeenCalled();
  });

  it("should pass normalized sfen and hash to the database search", async () => {
    sfenMock.getNormalizedSfenAndHash.mockReturnValue({
      sfen: "normalized sfen",
      hash: 123n,
    });

    const response = await requestApp(
      app,
      "GET",
      `/api/kifu/search?sfen=${encodeURIComponent("position startpos")}`,
      { host },
    );

    expect(response.status).toBe(200);
    expect(kifuIndexMock.searchKifu).toHaveBeenCalledWith({
      sfen: "normalized sfen",
      sfenHash: 123n,
      keyword: undefined,
      player1: undefined,
      player2: undefined,
      isStrictTurn: false,
      startDate: undefined,
      strategy: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it("should pass player1, player2, and isStrictTurn to the database search", async () => {
    const response = await requestApp(
      app,
      "GET",
      "/api/kifu/search?player1=Habu&player2=Fujii&isStrictTurn=true",
      { host },
    );

    expect(response.status).toBe(200);
    expect(kifuIndexMock.searchKifu).toHaveBeenCalledWith({
      sfen: undefined,
      sfenHash: undefined,
      keyword: undefined,
      player1: "Habu",
      player2: "Fujii",
      isStrictTurn: true,
      startDate: undefined,
      strategy: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it("should ignore invalid pagination query values", async () => {
    const response = await requestApp(app, "GET", "/api/kifu/search?limit=abc&offset=invalid", {
      host,
    });

    expect(response.status).toBe(200);
    expect(kifuIndexMock.searchKifu).toHaveBeenCalledWith({
      sfen: undefined,
      sfenHash: undefined,
      keyword: undefined,
      player1: undefined,
      player2: undefined,
      isStrictTurn: false,
      startDate: undefined,
      strategy: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it("returns the uncapped search result count", async () => {
    kifuIndexMock.getKifuSearchCount.mockReturnValue(2431);

    const response = await requestApp(app, "GET", "/api/kifu/search/count?keyword=title", {
      host,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 2431 });
    expect(kifuIndexMock.getKifuSearchCount).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "title" }),
    );
  });

  it("passes an allowed strategy filter to the database search", async () => {
    const response = await requestApp(
      app,
      "GET",
      "/api/kifu/search?strategy=%E8%A7%92%E6%8F%9B%E3%82%8F%E3%82%8A",
      {
        host,
      },
    );

    expect(response.status).toBe(200);
    expect(kifuIndexMock.searchKifu).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "角換わり" }),
    );
  });

  it("passes the unclassified strategy filter to the database search", async () => {
    const response = await requestApp(app, "GET", "/api/kifu/search?strategy=unclassified", {
      host,
    });

    expect(response.status).toBe(200);
    expect(kifuIndexMock.searchKifu).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "unclassified" }),
    );
  });

  it("rejects unsupported strategy filters", async () => {
    const response = await requestApp(app, "GET", "/api/kifu/search?strategy=unsupported", {
      host,
    });

    expect(response.status).toBe(400);
    expect(kifuIndexMock.searchKifu).not.toHaveBeenCalled();
  });

  it("rejects invalid SFEN export options", async () => {
    const response = await requestApp(app, "POST", "/api/kifu/export/sfen", {
      host,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "result.txt",
        search: {},
        maxMoves: 0,
      }),
    });

    expect(response.status).toBe(400);
    expect(exportJobMock.startSfenExportJob).not.toHaveBeenCalled();
  });

  it("rejects malformed export search fields", async () => {
    const response = await requestApp(app, "POST", "/api/kifu/export/sfen", {
      host,
      json: {
        filename: "result.sfen",
        search: { keyword: 123 },
        standardInitialOnly: false,
        overwrite: false,
      },
    });

    expect(response.status).toBe(400);
    expect(exportJobMock.startSfenExportJob).not.toHaveBeenCalled();
  });
});
