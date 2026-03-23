import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const SERVER_PORT = vi.hoisted(() => {
  return 8200 + Math.floor(Math.random() * 100);
});

vi.hoisted(() => {
  process.env.PORT = SERVER_PORT.toString();
  process.env.KIFU_DIR = "./records";
});

const mockServer = vi.hoisted(() => ({
  listen: (port: number, callback?: () => void) => {
    if (typeof callback === "function") callback();
    return mockServer;
  },
  close: (callback?: () => void) => {
    if (typeof callback === "function") callback();
  },
  on: () => mockServer,
}));

vi.mock("http", () => ({
  default: {
    createServer: vi.fn(() => mockServer),
  },
}));

const sqliteMock = vi.hoisted(() => ({
  initDatabase: vi.fn(),
  saveAnalysisResults: vi.fn(),
  getAnalysisResults: vi.fn(() => []),
  getAnalysisDBStats: vi.fn(() => []),
  deleteAnalysisResultsByEngine: vi.fn(),
  cleanupAnalysisResults: vi.fn(),
  exportAnalysisResultsByEngine: vi.fn(function* () {
    yield "#YANEURAOU-DB2016 1.00\n";
  }),
}));

vi.mock("@/background/database/sqlite.js", () => sqliteMock);

// eslint-disable-next-line no-restricted-imports
import { app } from "../../../server.js";

describe("Analysis DB API error handling", () => {
  beforeAll(() => {
    mockServer.listen(SERVER_PORT);
  });

  afterAll(() => {
    mockServer.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sqliteMock.getAnalysisResults.mockReturnValue([]);
    sqliteMock.getAnalysisDBStats.mockReturnValue([]);
    sqliteMock.deleteAnalysisResultsByEngine.mockImplementation(() => undefined);
    sqliteMock.cleanupAnalysisResults.mockImplementation(() => undefined);
  });

  it("should return 500 when stats retrieval fails", async () => {
    sqliteMock.getAnalysisDBStats.mockImplementation(() => {
      throw new Error("stats failure");
    });

    const response = await request(app)
      .get("/api/analysis/stats")
      .set("Host", `localhost:${SERVER_PORT}`);

    expect(response.status).toBe(500);
    expect(response.text).toContain("failed to get analysis db stats");
  });

  it("should return 500 when delete_by_engine fails", async () => {
    sqliteMock.deleteAnalysisResultsByEngine.mockImplementation(() => {
      throw new Error("delete failure");
    });

    const response = await request(app)
      .post("/api/analysis/delete_by_engine")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ engineId: 1 });

    expect(response.status).toBe(500);
    expect(response.text).toContain("failed to delete analysis results by engine");
  });

  it("should return 500 when cleanup fails", async () => {
    sqliteMock.cleanupAnalysisResults.mockImplementation(() => {
      throw new Error("cleanup failure");
    });

    const response = await request(app)
      .post("/api/analysis/cleanup")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ minDepth: 10 });

    expect(response.status).toBe(500);
    expect(response.text).toContain("failed to cleanup analysis results");
  });
});
