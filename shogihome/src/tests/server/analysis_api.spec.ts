import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const SERVER_PORT = vi.hoisted(() => {
  return 8200 + Math.floor(Math.random() * 100);
});

vi.hoisted(() => {
  process.env.PORT = SERVER_PORT.toString();
  process.env.KIFU_DIR = "./data";
});

const sqliteMock = vi.hoisted(() => ({
  initDatabase: vi.fn(),
  saveAnalysisResults: vi.fn(),
  getAnalysisResults: vi.fn(() => [] as unknown[]),
  getAnalysisDBStats: vi.fn(() => [] as unknown[]),
  deleteAnalysisResultsByEngine: vi.fn(),
  cleanupAnalysisResults: vi.fn(),
  deleteAnalysisResult: vi.fn(),
  exportAnalysisResultsByEngine: vi.fn(function* () {
    yield "#YANEURAOU-DB2016 1.00\n";
  }),
}));

vi.mock("@/background/database/sqlite.js", () => sqliteMock);

// eslint-disable-next-line no-restricted-imports
import { app } from "../../../server.js";

describe("Analysis DB API error handling", () => {
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
    expect(response.text).toContain("stats failure");
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
    expect(response.text).toContain("delete failure");
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
    expect(response.text).toContain("cleanup failure");
  });

  it("should return 200 and data when stats retrieval succeeds", async () => {
    sqliteMock.getAnalysisDBStats.mockReturnValue([{ engineName: "test", count: 10 }]);

    const response = await request(app)
      .get("/api/analysis/stats")
      .set("Host", `localhost:${SERVER_PORT}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ engineName: "test", count: 10 }]);
  });

  it("should return 200 when delete_by_engine succeeds", async () => {
    const response = await request(app)
      .post("/api/analysis/delete_by_engine")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ engineId: 1 });

    expect(response.status).toBe(200);
    expect(sqliteMock.deleteAnalysisResultsByEngine).toHaveBeenCalledWith(1);
  });

  it("should return 200 when cleanup succeeds", async () => {
    const response = await request(app)
      .post("/api/analysis/cleanup")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ minDepth: 10 });

    expect(response.status).toBe(200);
    expect(sqliteMock.cleanupAnalysisResults).toHaveBeenCalledWith(10);
  });

  it("should return 200 when delete succeeds", async () => {
    const response = await request(app)
      .post("/api/analysis/delete")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ sfen: "startpos", engineId: 1, multipv: 1 });

    expect(response.status).toBe(200);
    expect(sqliteMock.deleteAnalysisResult).toHaveBeenCalledWith(
      expect.any(BigInt),
      expect.any(String),
      1,
      1,
    );
  });

  it("should return 400 when delete fails due to missing sfen", async () => {
    const response = await request(app)
      .post("/api/analysis/delete")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ engineId: 1, multipv: 1 });

    expect(response.status).toBe(400);
    expect(response.text).toContain("sfen is required");
  });

  it("should return 400 when delete fails due to invalid engineId", async () => {
    const response = await request(app)
      .post("/api/analysis/delete")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ sfen: "startpos", engineId: -1, multipv: 1 });

    expect(response.status).toBe(400);
    expect(response.text).toContain("engineId must be a positive integer");
  });

  it("should return 400 when delete fails due to invalid multipv", async () => {
    const response = await request(app)
      .post("/api/analysis/delete")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ sfen: "startpos", engineId: 1, multipv: 0 });

    expect(response.status).toBe(400);
    expect(response.text).toContain("multipv must be a positive integer");
  });

  it("should return 400 when delete fails due to invalid sfen", async () => {
    const response = await request(app)
      .post("/api/analysis/delete")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ sfen: "invalid-sfen", engineId: 1, multipv: 1 });

    expect(response.status).toBe(400);
    expect(response.text).toContain("invalid sfen");
  });

  it("should return 500 when delete fails due to database error", async () => {
    sqliteMock.deleteAnalysisResult.mockImplementation(() => {
      throw new Error("delete database failure");
    });

    const response = await request(app)
      .post("/api/analysis/delete")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ sfen: "startpos", engineId: 1, multipv: 1 });

    expect(response.status).toBe(500);
    expect(response.text).toContain("delete database failure");
  });

  it("should export analysis results to a file", async () => {
    const response = await request(app)
      .post("/api/analysis/export")
      .set("Host", `localhost:${SERVER_PORT}`)
      .send({ engineId: 1, filename: "test-export.db" });

    expect(response.status).toBe(200);
    expect(response.text).toBe("ok");
    expect(sqliteMock.exportAnalysisResultsByEngine).toHaveBeenCalledWith(1);
  });
});
