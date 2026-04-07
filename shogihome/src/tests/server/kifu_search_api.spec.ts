import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

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

vi.mock("@/background/database/kifu_index.js", () => kifuIndexMock);
vi.mock("@/background/database/sqlite.js", () => sqliteMock);
vi.mock("@/background/usi/sfen.js", () => sfenMock);
vi.mock("@/background/kifu_index/sync.js", () => kifuIndexSyncMock);

// eslint-disable-next-line no-restricted-imports
import { app } from "../../../server.js";

describe("Kifu search API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kifuIndexMock.searchKifu.mockReturnValue([]);
  });

  it("should return 400 for invalid sfen queries", async () => {
    sfenMock.getNormalizedSfenAndHash.mockReturnValue(null);

    const response = await request(app)
      .get("/api/kifu/search")
      .set("Host", `localhost:${SERVER_PORT}`)
      .query({ sfen: "position invalid", keyword: "test" });

    expect(response.status).toBe(400);
    expect(response.text).toContain("Invalid sfen");
    expect(kifuIndexMock.searchKifu).not.toHaveBeenCalled();
  });

  it("should pass normalized sfen and hash to the database search", async () => {
    sfenMock.getNormalizedSfenAndHash.mockReturnValue({
      sfen: "normalized sfen",
      hash: 123n,
    });

    const response = await request(app)
      .get("/api/kifu/search")
      .set("Host", `localhost:${SERVER_PORT}`)
      .query({ sfen: "position startpos" });

    expect(response.status).toBe(200);
    expect(kifuIndexMock.searchKifu).toHaveBeenCalledWith({
      sfen: "normalized sfen",
      sfenHash: 123n,
      keyword: undefined,
      startDate: undefined,
      limit: undefined,
      offset: undefined,
    });
  });
});
