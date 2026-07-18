import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { requestApp, type TestResponse } from "./honoRequest";

vi.hoisted(() => {
  process.env.KIFU_DIR = "./data";
});

import { app } from "@/server/main";
import * as bookAPI from "@/server/book/index";
import { ONTHEFLY_THRESHOLD_MB, SBK_ONTHEFLY_THRESHOLD_MB } from "@/server/config";
import { runWithBookSessionLock } from "@/server/bookSessionManager";

const host = "localhost:8140";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

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
    updateBookMove: vi.fn(),
    removeBookMove: vi.fn(),
    updateBookMoveOrder: vi.fn(),
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should reject requests beyond the per-session lock queue limit", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const active = runWithBookSessionLock("bounded-lock-client", async () => {
      started.resolve(undefined);
      await release.promise;
    });
    await started.promise;

    const queued = Array.from({ length: 32 }, () =>
      runWithBookSessionLock("bounded-lock-client", async () => undefined),
    );
    const overflowResult = runWithBookSessionLock(
      "bounded-lock-client",
      async () => undefined,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    release.resolve(undefined);
    await active;
    await Promise.all(queued);

    await expect(overflowResult).resolves.toMatchObject({ status: 503 });
  });

  it("should time out requests waiting for the per-session lock", async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const release = deferred<void>();
    const active = runWithBookSessionLock("timed-lock-client", async () => {
      started.resolve(undefined);
      await release.promise;
    });
    await started.promise;

    const waitingResult = runWithBookSessionLock("timed-lock-client", async () => undefined).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    release.resolve(undefined);
    await active;

    await expect(waitingResult).resolves.toMatchObject({ status: 503 });
    vi.useRealTimers();
  });

  it("should assign different sessions for different clients", async () => {
    // We expect openBook to be called with different session IDs

    // First client
    await requestApp(app, "POST", "/api/book/open?path=test1.db", {
      host,
      headers: { "X-Book-Session-Id": "client-A" },
      json: {},
    });

    // Second client
    await requestApp(app, "POST", "/api/book/open?path=test2.db", {
      host,
      headers: { "X-Book-Session-Id": "client-B" },
      json: {},
    });

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
    const response = await requestApp(app, "GET", "/api/book/search?sfen=startpos", {
      host,
      headers: { "X-Book-Session-Id": "new-client" },
    });

    expect(response.status).toBe(200);
    expect(bookAPI.searchBookMoves).toHaveBeenCalled();
  });

  it("should ignore client-provided on-the-fly threshold", async () => {
    await requestApp(app, "POST", "/api/book/open?path=test1.db", {
      host,
      headers: { "X-Book-Session-Id": "client-threshold" },
      json: { onTheFlyThresholdMB: 1 },
    });

    const call = vi.mocked(bookAPI.openBook).mock.calls[0];
    expect(call[2]).toEqual({
      onTheFlyThresholdMB: ONTHEFLY_THRESHOLD_MB,
      sbkOnTheFlyThresholdMB: SBK_ONTHEFLY_THRESHOLD_MB,
    });
    expect(call[2]?.onTheFlyThresholdMB).not.toBe(1);
    expect(call[2]?.sbkOnTheFlyThresholdMB).toBe(SBK_ONTHEFLY_THRESHOLD_MB);
  });

  it("should return 400 error when X-Book-Session-Id header is missing", async () => {
    const response = await requestApp(app, "GET", "/api/book/search?sfen=startpos", { host });

    expect(response.status).toBe(400);
    expect(response.textBody).toContain("Invalid or missing X-Book-Session-Id header");
  });

  it("should reject invalid import ply ranges before importing", async () => {
    const response = await requestApp(app, "POST", "/api/book/import", {
      host,
      headers: { "X-Book-Session-Id": "client-import" },
      json: { minPly: "invalid", maxPly: 100 },
    });

    expect(response.status).toBe(400);
    expect(response.textBody).toContain("minPly must be a non-negative integer");
    expect(bookAPI.importBookMoves).not.toHaveBeenCalled();
  });

  it("should pass update query values to the book API", async () => {
    const response = await requestApp(app, "POST", "/api/book/update?sfen=startpos", {
      host,
      headers: { "X-Book-Session-Id": "client-update" },
      json: { move: "7g7f" },
    });

    expect(response.status).toBe(200);
    expect(bookAPI.updateBookMove).toHaveBeenCalledWith(expect.any(Number), "startpos", {
      move: "7g7f",
    });
  });

  it("should pass remove query values to the book API", async () => {
    const response = await requestApp(app, "POST", "/api/book/remove?sfen=startpos&usi=7g7f", {
      host,
      headers: { "X-Book-Session-Id": "client-remove" },
    });

    expect(response.status).toBe(200);
    expect(bookAPI.removeBookMove).toHaveBeenCalledWith(expect.any(Number), "startpos", "7g7f");
  });

  it("should validate order query values before updating move order", async () => {
    const invalidResponse = await requestApp(
      app,
      "POST",
      "/api/book/order?sfen=startpos&usi=7g7f&order=invalid",
      {
        host,
        headers: { "X-Book-Session-Id": "client-order-invalid" },
      },
    );

    expect(invalidResponse.status).toBe(400);
    expect(bookAPI.updateBookMoveOrder).not.toHaveBeenCalled();

    const response = await requestApp(
      app,
      "POST",
      "/api/book/order?sfen=startpos&usi=7g7f&order=2",
      {
        host,
        headers: { "X-Book-Session-Id": "client-order" },
      },
    );

    expect(response.status).toBe(200);
    expect(bookAPI.updateBookMoveOrder).toHaveBeenCalledWith(
      expect.any(Number),
      "startpos",
      "7g7f",
      2,
    );
  });

  it("should return 400 error when batch search sfens array is too large", async () => {
    const largeSfens = new Array(100001).fill("startpos");
    const response = await requestApp(app, "POST", "/api/book/search/batch", {
      host,
      headers: { "X-Book-Session-Id": "client-A" },
      json: { sfens: largeSfens },
    });

    expect(response.status).toBe(400);
    expect(response.textBody).toContain("max 100000");
  });

  it("should return batch search results in correct order even with worker pool", async () => {
    const sfens = Array.from({ length: 100 }, (_, i) => `sfen_at_index_${i}`);
    const response = await requestApp(app, "POST", "/api/book/search/batch", {
      host,
      headers: { "X-Book-Session-Id": "client-A" },
      json: { sfens },
    });

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(100);
    response.body.forEach((item, i) => {
      expect(item.sfen).toBe(sfens[i]);
    });
  });

  it("should serialize operations for the same external session", async () => {
    const openResult = deferred<"in-memory">();
    vi.mocked(bookAPI.openBook).mockReturnValueOnce(openResult.promise);

    const openRequest = requestApp(app, "POST", "/api/book/open?path=test1.db", {
      host,
      headers: { "X-Book-Session-Id": "serial-client" },
      json: {},
    });
    await vi.waitFor(() => expect(bookAPI.openBook).toHaveBeenCalledOnce());

    const updateRequest = requestApp(app, "POST", "/api/book/update?sfen=startpos", {
      host,
      headers: { "X-Book-Session-Id": "serial-client" },
      json: { move: "7g7f" },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(bookAPI.updateBookMove).not.toHaveBeenCalled();

    openResult.resolve("in-memory");
    await expect(openRequest).resolves.toMatchObject({ status: 200 });
    await expect(updateRequest).resolves.toMatchObject({ status: 200 });
    expect(bookAPI.updateBookMove).toHaveBeenCalledOnce();
  });

  it("should allow different external sessions to run concurrently", async () => {
    const openResult = deferred<"in-memory">();
    vi.mocked(bookAPI.openBook).mockReturnValueOnce(openResult.promise);

    const openRequest = requestApp(app, "POST", "/api/book/open?path=test1.db", {
      host,
      headers: { "X-Book-Session-Id": "parallel-client-a" },
      json: {},
    });
    await vi.waitFor(() => expect(bookAPI.openBook).toHaveBeenCalledOnce());

    const updateRequest = requestApp(app, "POST", "/api/book/update?sfen=startpos", {
      host,
      headers: { "X-Book-Session-Id": "parallel-client-b" },
      json: { move: "2g2f" },
    });
    await expect(updateRequest).resolves.toMatchObject({ status: 200 });

    openResult.resolve("in-memory");
    await expect(openRequest).resolves.toMatchObject({ status: 200 });
  });

  it("should wait for an active batch search before closing the same session", async () => {
    const searchResult = deferred<never[]>();
    vi.mocked(bookAPI.searchBookMoves).mockReturnValueOnce(searchResult.promise);

    const searchRequest = requestApp(app, "POST", "/api/book/search/batch", {
      host,
      headers: { "X-Book-Session-Id": "batch-close-client" },
      json: { sfens: ["startpos"] },
    });
    await vi.waitFor(() => expect(bookAPI.searchBookMoves).toHaveBeenCalledOnce());

    const closeRequest = requestApp(app, "POST", "/api/book/close", {
      host,
      headers: { "X-Book-Session-Id": "batch-close-client" },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(bookAPI.closeBookSession).not.toHaveBeenCalled();

    searchResult.resolve([]);
    await expect(searchRequest).resolves.toMatchObject({ status: 200 });
    await expect(closeRequest).resolves.toMatchObject({ status: 200 });
    expect(bookAPI.closeBookSession).toHaveBeenCalledOnce();
  });

  it("should handle large batch search up to 10000 items without error", async () => {
    const sfens = new Array(10000).fill("startpos");
    const response = await requestApp(app, "POST", "/api/book/search/batch", {
      host,
      headers: { "X-Book-Session-Id": "client-A" },
      json: { sfens },
    });

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(10000);
  });

  it("should return 503 when the book session limit is reached", async () => {
    let limitResponse: TestResponse | undefined;
    for (let i = 0; i < 60; i++) {
      const response = await requestApp(app, "GET", "/api/book/search?sfen=startpos", {
        host,
        headers: { "X-Book-Session-Id": `limit-client-${i}` },
      });
      if (response.status === 503) {
        limitResponse = response;
        break;
      }
    }

    expect(limitResponse?.status).toBe(503);
    expect(limitResponse?.textBody).toContain("Book session limit reached");
  });
});
