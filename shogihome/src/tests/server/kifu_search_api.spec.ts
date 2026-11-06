import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestApp } from "./honoRequest";
import { t } from "@/common/i18n";
import { webAPI } from "@/renderer/ipc/web";
import { KIFU_SEARCH_RATE_LIMIT } from "@/server/security";

const SERVER_PORT = vi.hoisted(() => {
  return 8300 + Math.floor(Math.random() * 100);
});

const client = vi.hoisted(() => ({ address: "search-client", sequence: 0 }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: client.address } }),
}));

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
  getKifuSearchStatistics: vi.fn(() => ({
    total: 1,
    generatedAt: 100,
    strategies: [{ strategy: "unclassified", count: 1 }],
    players: [{ name: "A", black: 1, white: 1, total: 2 }],
    otherPlayers: { black: 0, white: 0, total: 0 },
    nextMoves: [{ move: "☗２五歩", count: 1 }],
  })),
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
    client.address = `search-client-${++client.sequence}`;
    kifuIndexMock.searchKifu.mockReturnValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("should return 400 for invalid sfen queries", async () => {
    sfenMock.getNormalizedSfenAndHash.mockReturnValue(null);

    const response = await requestApp(
      app,
      "GET",
      `/api/kifu/search?sfen=${encodeURIComponent("position invalid")}&keyword=test`,
      { host },
    );

    expect(response.status).toBe(400);
    expect(response.textBody).toContain(t.serverInvalidKifuSearch);
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

  it.each([
    { query: "", isStrictTurn: false },
    { query: "isStrictTurn=", isStrictTurn: false },
    { query: "isStrictTurn=false", isStrictTurn: false },
    { query: "isStrictTurn=true", isStrictTurn: true },
  ])(
    "normalizes turn filters at every search endpoint: $query",
    async ({ query, isStrictTurn }) => {
      for (const [route, search] of [
        ["/search", kifuIndexMock.searchKifu],
        ["/search/count", kifuIndexMock.getKifuSearchCount],
        ["/search/statistics", kifuIndexMock.getKifuSearchStatistics],
      ] as const) {
        const response = await requestApp(
          app,
          "GET",
          `/api/kifu${route}${query ? `?${query}` : ""}`,
          { host },
        );
        expect(response.status).toBe(200);
        expect(search).toHaveBeenCalledWith(expect.objectContaining({ isStrictTurn }));
      }
    },
  );

  it.each([undefined, false, true])(
    "round-trips renderer turn filters through every search API: %s",
    async (isStrictTurn) => {
      sfenMock.getNormalizedSfenAndHash.mockReturnValue({ sfen: "normalized sfen", hash: 123n });
      kifuIndexMock.getKifuSearchCount.mockReturnValue(1);
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Host", host);
        return app.request(input, { ...init, headers });
      });
      const params = {
        sfen: "position startpos",
        keyword: "Final",
        player1: "A",
        player2: "B",
        isStrictTurn,
        startDate: "2024",
        strategy: "unclassified" as const,
      };

      await expect(webAPI.searchServerKifu({ ...params, limit: 10, offset: 0 })).resolves.toEqual(
        [],
      );
      await expect(webAPI.countServerKifu(params)).resolves.toBe(1);
      await expect(webAPI.getServerKifuStatistics(params)).resolves.toMatchObject({ total: 1 });

      const normalized = {
        ...params,
        sfen: "normalized sfen",
        sfenHash: 123n,
        isStrictTurn: isStrictTurn ?? false,
      };
      expect(kifuIndexMock.searchKifu).toHaveBeenCalledWith({
        ...normalized,
        limit: 10,
        offset: 0,
      });
      expect(kifuIndexMock.getKifuSearchCount).toHaveBeenCalledWith(normalized);
      expect(kifuIndexMock.getKifuSearchStatistics).toHaveBeenCalledWith(normalized);
      expect(fetch).toHaveBeenCalledTimes(3);
      for (const [input] of fetch.mock.calls) {
        expect(new URL(String(input)).searchParams.get("isStrictTurn")).toBe(
          isStrictTurn ? "true" : null,
        );
      }
    },
  );

  it("rejects invalid pagination instead of ignoring it", async () => {
    const response = await requestApp(app, "GET", "/api/kifu/search?limit=abc&offset=invalid", {
      host,
    });

    expect(response.status).toBe(400);
    expect(response.textBody).toContain(t.serverInvalidKifuPagination);
    expect(kifuIndexMock.searchKifu).not.toHaveBeenCalled();
  });

  it.each([
    "limit=-1",
    "limit=0",
    "limit=1001",
    "limit=1.5",
    "limit=10junk",
    "limit=1e2",
    "limit=",
    "limit=1&limit=2",
    "offset=-1",
    "offset=0.5",
    "offset=9007199254740992",
  ])("rejects unsafe pagination: %s", async (query) => {
    const response = await requestApp(app, "GET", `/api/kifu/search?${query}`, { host });
    expect(response.status).toBe(400);
    expect(kifuIndexMock.searchKifu).not.toHaveBeenCalled();
  });

  it("accepts pagination bounds without changing list/count behavior", async () => {
    const responses = await Promise.all([
      requestApp(app, "GET", "/api/kifu/search?limit=1000&offset=0", { host }),
      requestApp(app, "GET", "/api/kifu/search/count", { host }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(kifuIndexMock.searchKifu).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000, offset: 0 }),
    );
  });

  const oversizedQueries: Record<string, string>[] = [
    { keyword: "x".repeat(1025) },
    { keyword: Array(17).fill("x").join(" ") },
    { keyword: "x".repeat(129) },
    { player1: "x".repeat(129) },
    { player2: "x".repeat(129) },
    { startDate: "x".repeat(33) },
    { sfen: "x".repeat(1025) },
  ];
  it.each(oversizedQueries)(
    "rejects over-budget inputs at every search entry point: %j",
    async (search) => {
      const query = new URLSearchParams(search).toString();
      for (const route of ["/search", "/search/count", "/search/statistics"]) {
        expect((await requestApp(app, "GET", `/api/kifu${route}?${query}`, { host })).status).toBe(
          400,
        );
      }
      expect(
        (
          await requestApp(app, "POST", "/api/kifu/export/sfen", {
            host,
            json: { filename: "result.sfen", search },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await requestApp(app, "POST", "/api/analysis-jobs/batch/prepare", {
            host,
            json: { kind: "search", search },
          })
        ).status,
      ).toBe(400);
      expect(kifuIndexMock.searchKifu).not.toHaveBeenCalled();
      expect(kifuIndexMock.getKifuSearchCount).not.toHaveBeenCalled();
      expect(kifuIndexMock.getKifuSearchStatistics).not.toHaveBeenCalled();
      expect(exportJobMock.startSfenExportJob).not.toHaveBeenCalled();
    },
  );

  it.each([
    "keyword=a&keyword=b",
    "player1=a&player1=b",
    "isStrictTurn=invalid",
    "isStrictTurn=true&isStrictTurn=false",
    "isStrictTurn=&isStrictTurn=false",
  ])(
    "rejects repeated filters and malformed booleans at every search endpoint: %s",
    async (query) => {
      for (const route of ["/search", "/search/count", "/search/statistics"]) {
        expect((await requestApp(app, "GET", `/api/kifu${route}?${query}`, { host })).status).toBe(
          400,
        );
      }
      expect(kifuIndexMock.searchKifu).not.toHaveBeenCalled();
      expect(kifuIndexMock.getKifuSearchCount).not.toHaveBeenCalled();
      expect(kifuIndexMock.getKifuSearchStatistics).not.toHaveBeenCalled();
    },
  );

  it("shares one rate budget across list, count, statistics, export, and batch preparation", async () => {
    const routes = ["/search", "/search/count", "/search/statistics"];
    for (let index = 0; index < KIFU_SEARCH_RATE_LIMIT; index++) {
      expect(
        (await requestApp(app, "GET", `/api/kifu${routes[index % routes.length]}`, { host }))
          .status,
      ).toBe(200);
    }
    const calls = kifuIndexMock.searchKifu.mock.calls.length;
    const response = await requestApp(app, "GET", "/api/kifu/search", { host });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(kifuIndexMock.searchKifu).toHaveBeenCalledTimes(calls);
    expect(
      (await requestApp(app, "POST", "/api/kifu/export/sfen", { host, json: {} })).status,
    ).toBe(429);
    expect(
      (await requestApp(app, "POST", "/api/analysis-jobs/batch/prepare", { host, json: {} }))
        .status,
    ).toBe(429);
    expect((await requestApp(app, "GET", "/api/kifu/index/status", { host })).status).toBe(200);
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

  it("uses normalized combined filters for statistics without applying result pagination", async () => {
    sfenMock.getNormalizedSfenAndHash.mockReturnValue({ sfen: "normalized sfen", hash: 123n });
    const response = await requestApp(
      app,
      "GET",
      "/api/kifu/search/statistics?sfen=startpos&keyword=Final&player1=A&player2=B&isStrictTurn=true&startDate=2024&strategy=unclassified&limit=1&offset=100",
      { host },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      total: 1,
      generatedAt: 100,
      strategies: [{ strategy: "unclassified", count: 1 }],
      players: [{ name: "A", black: 1, white: 1, total: 2 }],
      otherPlayers: { black: 0, white: 0, total: 0 },
      nextMoves: [{ move: "☗２五歩", count: 1 }],
    });
    expect(kifuIndexMock.getKifuSearchStatistics).toHaveBeenCalledWith({
      sfen: "normalized sfen",
      sfenHash: 123n,
      keyword: "Final",
      player1: "A",
      player2: "B",
      isStrictTurn: true,
      startDate: "2024",
      strategy: "unclassified",
    });
  });

  it("rejects invalid statistics queries before querying the index", async () => {
    sfenMock.getNormalizedSfenAndHash.mockReturnValue(null);
    for (const query of ["sfen=invalid", "strategy=unsupported"]) {
      const response = await requestApp(app, "GET", `/api/kifu/search/statistics?${query}`, {
        host,
      });
      expect(response.status).toBe(400);
    }
    expect(kifuIndexMock.getKifuSearchStatistics).not.toHaveBeenCalled();
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
