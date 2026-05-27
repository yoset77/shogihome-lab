import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

vi.hoisted(() => {
  process.env.KIFU_DIR = "./data";
});

import { app } from "@/server/main";
import * as bookAPI from "@/server/book/index";
import { ONTHEFLY_THRESHOLD_MB, SBK_ONTHEFLY_THRESHOLD_MB } from "@/server/config";

// Mock the dependencies
vi.mock("@/server/book/index.js", () => {
  let sessionCounter = 100;
  const sessions = new Set<number>();

  return {
    openBook: vi.fn(async (session: number) => {
      sessions.add(session);
      return "in-memory";
    }),
    saveBook: vi.fn(),
    clearBook: vi.fn((session: number) => {
      sessions.delete(session);
    }),
    searchBookMoves: vi.fn(async () => {
      return [];
    }),
    initBookSession: vi.fn((session: number) => {
      sessions.add(session);
    }),
    closeBookSession: vi.fn((session: number) => {
      sessions.delete(session);
    }),
    importBookMoves: vi.fn(async () => {
      return {
        successFileCount: 0,
        errorFileCount: 0,
        skippedFileCount: 0,
        importedMoveCount: 0,
      };
    }),
    isBookOnTheFly: vi.fn(() => false),
    openBookAsNewSession: vi.fn(async () => {
      const session = sessionCounter++;
      sessions.add(session);
      return { session, mode: "in-memory" };
    }),
    __getSessions: () => Array.from(sessions),
  };
});

describe("Book Session API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {});

  it("should assign different sessions for different clients", async () => {
    // We expect openBook to be called with different session IDs

    // First client
    await request(app)
      .post("/api/book/open?path=test1.db")
      .set("X-Book-Session-Id", "client-A")
      .set("Host", "localhost:8140")
      .send({});

    // Second client
    await request(app)
      .post("/api/book/open?path=test2.db")
      .set("X-Book-Session-Id", "client-B")
      .set("Host", "localhost:8140")
      .send({});

    // Check that openBook was called twice
    expect(bookAPI.openBook).toHaveBeenCalledTimes(2);

    // Get the arguments of the two calls
    const call1 = vi.mocked(bookAPI.openBook).mock.calls[0];
    const call2 = vi.mocked(bookAPI.openBook).mock.calls[1];

    // The session IDs should be different
    expect(call1[0]).not.toEqual(call2[0]);
  });

  it("should initialize a new session automatically to avoid 500 error", async () => {
    // Access search without opening first
    const response = await request(app)
      .get("/api/book/search?sfen=startpos")
      .set("X-Book-Session-Id", "new-client")
      .set("Host", "localhost:8140");

    expect(response.status).toBe(200);
    expect(bookAPI.searchBookMoves).toHaveBeenCalled();
  });

  it("should ignore client-provided on-the-fly threshold", async () => {
    await request(app)
      .post("/api/book/open?path=test1.db")
      .set("X-Book-Session-Id", "client-threshold")
      .set("Host", "localhost:8140")
      .send({ onTheFlyThresholdMB: 1, forceOnTheFly: false });

    const call = vi.mocked(bookAPI.openBook).mock.calls[0];
    expect(call[2]).toEqual({
      forceOnTheFly: false,
      onTheFlyThresholdMB: ONTHEFLY_THRESHOLD_MB,
      sbkOnTheFlyThresholdMB: SBK_ONTHEFLY_THRESHOLD_MB,
    });
    expect(call[2]?.onTheFlyThresholdMB).not.toBe(1);
    expect(call[2]?.sbkOnTheFlyThresholdMB).toBe(SBK_ONTHEFLY_THRESHOLD_MB);
  });

  it("should return 400 error when X-Book-Session-Id header is missing", async () => {
    const response = await request(app)
      .get("/api/book/search?sfen=startpos")
      .set("Host", "localhost:8140");

    expect(response.status).toBe(400);
    expect(response.text).toContain("Invalid or missing X-Book-Session-Id header");
  });

  it("should reject invalid import ply ranges before importing", async () => {
    const response = await request(app)
      .post("/api/book/import")
      .set("X-Book-Session-Id", "client-import")
      .set("Host", "localhost:8140")
      .send({ minPly: "invalid", maxPly: 100 });

    expect(response.status).toBe(400);
    expect(response.text).toContain("minPly must be a non-negative integer");
    expect(bookAPI.importBookMoves).not.toHaveBeenCalled();
  });

  it("should return 400 error when batch search sfens array is too large", async () => {
    const largeSfens = new Array(100001).fill("startpos");
    const response = await request(app)
      .post("/api/book/search/batch")
      .set("X-Book-Session-Id", "client-A")
      .set("Host", "localhost:8140")
      .send({ sfens: largeSfens });

    expect(response.status).toBe(400);
    expect(response.text).toContain("max 100000");
  });

  it("should return batch search results in correct order even with worker pool", async () => {
    const sfens = Array.from({ length: 100 }, (_, i) => `sfen_at_index_${i}`);
    const response = await request(app)
      .post("/api/book/search/batch")
      .set("X-Book-Session-Id", "client-A")
      .set("Host", "localhost:8140")
      .send({ sfens });

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(100);
    response.body.forEach((item: { sfen: string }, i: number) => {
      expect(item.sfen).toBe(sfens[i]);
    });
  });

  it("should handle large batch search up to 10000 items without error", async () => {
    const sfens = new Array(10000).fill("startpos");
    const response = await request(app)
      .post("/api/book/search/batch")
      .set("X-Book-Session-Id", "client-A")
      .set("Host", "localhost:8140")
      .send({ sfens });

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(10000);
  });

  it("should return 503 when the book session limit is reached", async () => {
    let limitResponse: request.Response | undefined;
    for (let i = 0; i < 60; i++) {
      const response = await request(app)
        .get("/api/book/search?sfen=startpos")
        .set("X-Book-Session-Id", `limit-client-${i}`)
        .set("Host", "localhost:8140");
      if (response.status === 503) {
        limitResponse = response;
        break;
      }
    }

    expect(limitResponse?.status).toBe(503);
    expect(limitResponse?.text).toContain("Book session limit reached");
  });
});
