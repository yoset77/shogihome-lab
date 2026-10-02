import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import { requestApp, type TestResponse } from "./honoRequest";

const tempKifuDir = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-book-session-"));
  process.env.KIFU_DIR = dir;
  return dir;
});

import { app } from "@/server/main";
import * as bookAPI from "@/server/book/index";
import {
  BOOK_SESSION_IDLE_TIMEOUT_MINUTES,
  ONTHEFLY_THRESHOLD_MB,
  SBK_ONTHEFLY_THRESHOLD_MB,
} from "@/server/config";
import { bookSessionManager, runWithBookSessionLock } from "@/server/bookSessionManager";
import { HttpError } from "@/server/errors";
import { t } from "@/common/i18n";
import * as bookValidation from "@/server/book/validation";

const host = "localhost:8140";
const normalizedStartpos = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

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
    getBookFormat: vi.fn(() => "sbk"),
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
  afterAll(() => {
    fs.rmSync(tempKifuDir, { recursive: true, force: true });
  });

  it("rejects an unknown session on save without initializing an empty book", async () => {
    const response = await requestApp(app, "POST", "/api/book/save?path=test.sbk&overwrite=true", {
      host,
      headers: { "X-Book-Session-Id": "unknown-save-client" },
    });
    expect(response.status).toBe(410);
    expect(bookAPI.initBookSession).not.toHaveBeenCalled();
    expect(bookAPI.saveBook).not.toHaveBeenCalled();
  });

  it("still rejects expired sessions after a second idle window", async () => {
    const id = "long-expired-client";
    bookSessionManager.get(id, true);
    const clock = vi.spyOn(Date, "now");
    const start = Date.now();
    try {
      clock.mockReturnValue(start + 25 * 60 * 60 * 1000);
      bookSessionManager.cleanup();
      await vi.waitFor(() => expect(bookSessionManager.has(id)).toBe(false));
      clock.mockReturnValue(start + 50 * 60 * 60 * 1000);
      bookSessionManager.cleanup();
      expect(() => bookSessionManager.get(id)).toThrow(t.serverBookSessionExpired);
    } finally {
      clock.mockRestore();
      bookSessionManager.close(id);
    }
  });

  it.each([
    ["/api/book/update?sfen=startpos", { usi: "7g7f", comment: "" }],
    ["/api/book/remove?sfen=startpos&usi=7g7f", {}],
    ["/api/book/order?sfen=startpos&usi=7g7f&order=0", {}],
    ["/api/book/import", {}],
  ])("rejects an unknown session at %s", async (url, json) => {
    const response = await requestApp(app, "POST", url, {
      host,
      headers: { "X-Book-Session-Id": "unknown-edit-client" },
      json,
    });
    expect(response.status).toBe(410);
    expect(bookAPI.initBookSession).not.toHaveBeenCalled();
    expect(bookAPI.updateBookMove).not.toHaveBeenCalled();
    expect(bookAPI.removeBookMove).not.toHaveBeenCalled();
    expect(bookAPI.updateBookMoveOrder).not.toHaveBeenCalled();
    expect(bookAPI.importBookMoves).not.toHaveBeenCalled();
  });

  it("retains the original 24-hour idle window", () => {
    expect(BOOK_SESSION_IDLE_TIMEOUT_MINUTES).toBe(24 * 60);
    const id = "idle-window-client";
    bookSessionManager.get(id, true);
    const access = (bookSessionManager as unknown as { lastAccess: Map<string, number> })
      .lastAccess;
    try {
      access.set(id, Date.now() - 31 * 60 * 1000);
      bookSessionManager.cleanup();
      expect(bookSessionManager.has(id)).toBe(true);
    } finally {
      bookSessionManager.close(id);
    }
  });
  it("does not retain rejected session IDs after hitting the limit", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `resource-client-${i}`);
    try {
      for (const id of ids) bookSessionManager.get(id, true);
      const access = (bookSessionManager as unknown as { lastAccess: Map<string, number> })
        .lastAccess;
      for (let i = 0; i < 20; i++) {
        expect(() => bookSessionManager.get(`rejected-client-${i}`, true)).toThrow();
      }
      expect([...access.keys()].filter((key) => key.startsWith("rejected-client-"))).toHaveLength(
        0,
      );
    } finally {
      for (const id of ids) bookSessionManager.close(id);
    }
  });

  it("does not silently recreate expired sessions on save", async () => {
    const id = "expired-book-client";
    bookSessionManager.get(id, true);
    const access = (bookSessionManager as unknown as { lastAccess: Map<string, number> })
      .lastAccess;
    access.set(id, Date.now() - 25 * 60 * 60 * 1000);
    bookSessionManager.cleanup();
    await vi.waitFor(() => expect(access.has(id)).toBe(false));
    const response = await requestApp(app, "POST", "/api/book/save?path=test.sbk", {
      host,
      headers: { "X-Book-Session-Id": id },
    });
    expect(response.status).toBe(410);
    expect(bookAPI.saveBook).not.toHaveBeenCalled();
    const reopened = await requestApp(app, "POST", "/api/book/open?path=test.sbk", {
      host,
      headers: { "X-Book-Session-Id": id },
      json: {},
    });
    expect(reopened.status).toBe(200);
    bookSessionManager.close(id);
  });

  it("rejects non-book save paths before reaching the book writer", async () => {
    const response = await requestApp(app, "POST", "/api/book/save?path=record.kif", {
      host,
      headers: { "X-Book-Session-Id": "book-filetype-client" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(bookAPI.saveBook).not.toHaveBeenCalled();
  });

  it("rejects malformed book moves before changing session state", async () => {
    bookSessionManager.get("invalid-move-client", true);
    const response = await requestApp(app, "POST", "/api/book/update?sfen=startpos", {
      host,
      headers: { "X-Book-Session-Id": "invalid-move-client" },
      json: { usi: "7g7f\nsfen forged", comment: "", score: "bad" },
    });
    expect(response.status).toBe(400);
    expect(bookAPI.updateBookMove).not.toHaveBeenCalled();
  });

  it.each([
    { usi: "7g7f", comment: "", score: 1.5 },
    { usi: "7g7f", comment: "", depth: "20" },
    { usi: "7g7f", comment: "", evaluation: 100 },
    { usi: "7g7f", usi2: "3c3d\r2g2f", comment: "" },
    { usi: "7g7f", comment: 42 },
  ])("rejects an invalid book move field before updating: %j", async (move) => {
    bookSessionManager.get("invalid-fields-client", true);
    const response = await requestApp(app, "POST", "/api/book/update?sfen=startpos", {
      host,
      headers: { "X-Book-Session-Id": "invalid-fields-client" },
      json: move,
    });
    expect(response.status).toBe(400);
    expect(bookAPI.updateBookMove).not.toHaveBeenCalled();
  });
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

  it("requires explicit initialization before searching a new book", async () => {
    const response = await requestApp(app, "GET", "/api/book/search?sfen=startpos", {
      host,
      headers: { "X-Book-Session-Id": "new-client" },
    });

    expect(response.status).toBe(410);
    expect(bookAPI.searchBookMoves).not.toHaveBeenCalled();
    const headers = { "X-Book-Session-Id": "new-client" };
    expect((await requestApp(app, "POST", "/api/book/clear", { host, headers })).status).toBe(200);
    expect(
      (await requestApp(app, "GET", "/api/book/search?sfen=startpos", { host, headers })).status,
    ).toBe(200);
  });

  it("should preserve the book format when clearing a session", async () => {
    const response = await requestApp(app, "POST", "/api/book/clear", {
      host,
      headers: { "X-Book-Session-Id": "clear-client" },
    });

    expect(response.status).toBe(200);
    const session = vi.mocked(bookAPI.getBookFormat).mock.calls[0][0];
    expect(bookAPI.clearBook).toHaveBeenCalledWith(session, "sbk");
  });

  it("should initialize a session with the requested format when clearing", async () => {
    const response = await requestApp(app, "POST", "/api/book/clear?format=ybb", {
      host,
      headers: { "X-Book-Session-Id": "clear-format-client" },
    });

    expect(response.status).toBe(200);
    expect(bookAPI.clearBook).toHaveBeenCalledWith(expect.any(Number), "ybb");
  });

  it("should reject an invalid format when clearing", async () => {
    const response = await requestApp(app, "POST", "/api/book/clear?format=invalid", {
      host,
      headers: { "X-Book-Session-Id": "clear-invalid-client" },
    });

    expect(response.status).toBe(400);
    expect(bookAPI.clearBook).not.toHaveBeenCalled();
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

  it("returns a user-facing conflict for a concurrent book operation", async () => {
    bookSessionManager.get("busy-book-client", true);
    vi.mocked(bookAPI.saveBook).mockRejectedValueOnce(new HttpError(409, t.processingPleaseWait));
    const response = await requestApp(app, "POST", "/api/book/save?path=test.sbk", {
      host,
      headers: { "X-Book-Session-Id": "busy-book-client" },
    });
    expect(response.status).toBe(409);
    expect(response.textBody).toBe(t.processingPleaseWait);
  });

  it("allows only one book import across different sessions", async () => {
    bookSessionManager.get("import-concurrent-a", true);
    bookSessionManager.get("import-concurrent-b", true);
    const releaseImport = deferred<{
      successFileCount: number;
      errorFileCount: number;
      skippedFileCount: number;
    }>();
    vi.mocked(bookAPI.importBookMoves).mockReturnValueOnce(releaseImport.promise);
    const first = requestApp(app, "POST", "/api/book/import", {
      host,
      headers: { "X-Book-Session-Id": "import-concurrent-a" },
      json: {},
    });
    await vi.waitFor(() => expect(bookAPI.importBookMoves).toHaveBeenCalledOnce());
    const second = await requestApp(app, "POST", "/api/book/import", {
      host,
      headers: { "X-Book-Session-Id": "import-concurrent-b" },
      json: {},
    });
    expect(second.status).toBe(503);
    expect(bookAPI.importBookMoves).toHaveBeenCalledOnce();
    releaseImport.resolve({ successFileCount: 0, errorFileCount: 0, skippedFileCount: 0 });
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it("should pass update query values to the book API", async () => {
    bookSessionManager.get("client-update", true);
    const response = await requestApp(app, "POST", "/api/book/update?sfen=startpos", {
      host,
      headers: { "X-Book-Session-Id": "client-update" },
      json: { usi: "7g7f", comment: "" },
    });

    expect(response.status).toBe(200);
    expect(bookAPI.updateBookMove).toHaveBeenCalledWith(expect.any(Number), normalizedStartpos, {
      usi: "7g7f",
      comment: "",
    });
  });

  it("should pass remove query values to the book API", async () => {
    bookSessionManager.get("client-remove", true);
    const response = await requestApp(app, "POST", "/api/book/remove?sfen=startpos&usi=7g7f", {
      host,
      headers: { "X-Book-Session-Id": "client-remove" },
    });

    expect(response.status).toBe(200);
    expect(bookAPI.removeBookMove).toHaveBeenCalledWith(
      expect.any(Number),
      normalizedStartpos,
      "7g7f",
    );
  });

  it("should validate order query values before updating move order", async () => {
    bookSessionManager.get("client-order", true);
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
      normalizedStartpos,
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

  it("should serialize a search behind an in-flight save on the same session", async () => {
    bookSessionManager.get("save-lock-client", true);
    const releaseSave = deferred<void>();
    vi.mocked(bookAPI.saveBook).mockImplementation(() => releaseSave.promise);

    const saveRequest = requestApp(app, "POST", "/api/book/save?path=test.sbk", {
      host,
      headers: { "X-Book-Session-Id": "save-lock-client" },
    });
    await vi.waitFor(() => expect(bookAPI.saveBook).toHaveBeenCalled());

    let searchFinished = false;
    const searchRequest = requestApp(app, "GET", "/api/book/search?sfen=startpos", {
      host,
      headers: { "X-Book-Session-Id": "save-lock-client" },
    }).then((response: TestResponse) => {
      searchFinished = true;
      return response;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(searchFinished).toBe(false);

    releaseSave.resolve(undefined);
    const saveResponse = await saveRequest;
    expect(saveResponse.status).toBe(200);
    const searchResponse = await searchRequest;
    expect(searchResponse.status).toBe(200);
  });

  it("should return batch search results in correct order even with worker pool", async () => {
    bookSessionManager.get("client-A", true);
    const sfens = Array.from({ length: 100 }, (_, i) =>
      normalizedStartpos.replace(/ 1$/, ` ${i + 1}`),
    );
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

  it("yields during batch normalization before starting book searches", async () => {
    const id = "normalization-yield-client";
    bookSessionManager.get(id, true);
    const sfens = new Array(2000).fill(normalizedStartpos);
    const originalParse = bookValidation.parseBookSfen;
    const yielded = deferred<{ normalized: number; searched: number }>();
    let normalized = 0;
    const parse = vi.spyOn(bookValidation, "parseBookSfen").mockImplementation((input) => {
      if (++normalized === 1) {
        setImmediate(() =>
          yielded.resolve({
            normalized,
            searched: vi.mocked(bookAPI.searchBookMoves).mock.calls.length,
          }),
        );
      }
      return originalParse(input);
    });
    try {
      const response = await requestApp(app, "POST", "/api/book/search/batch", {
        host,
        headers: { "X-Book-Session-Id": id },
        json: { sfens },
      });
      const progress = await yielded.promise;
      expect(response.status).toBe(200);
      expect(progress.normalized).toBeGreaterThan(0);
      expect(progress.normalized).toBeLessThan(sfens.length);
      expect(progress.searched).toBe(0);
      expect(bookAPI.searchBookMoves).toHaveBeenCalledTimes(sfens.length);
    } finally {
      parse.mockRestore();
      bookSessionManager.close(id);
    }
  });

  it("yields during in-memory batch searches even when every lookup resolves immediately", async () => {
    const id = "search-yield-client";
    bookSessionManager.get(id, true);
    const sfens = new Array(2000).fill("startpos");
    const yielded = deferred<number>();
    const search = vi.mocked(bookAPI.searchBookMoves);
    search.mockImplementation(async () => {
      if (search.mock.calls.length === 1) {
        setImmediate(() => yielded.resolve(search.mock.calls.length));
      }
      return [];
    });
    try {
      const response = await requestApp(app, "POST", "/api/book/search/batch", {
        host,
        headers: { "X-Book-Session-Id": id },
        json: { sfens },
      });
      const searchedWhenYielded = await yielded.promise;
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(sfens.length);
      expect(searchedWhenYielded).toBeGreaterThan(0);
      expect(searchedWhenYielded).toBeLessThan(sfens.length);
    } finally {
      search.mockResolvedValue([]);
      bookSessionManager.close(id);
    }
  });

  it("rejects an invalid batch position before performing any searches", async () => {
    const id = "invalid-batch-client";
    bookSessionManager.get(id, true);
    try {
      const response = await requestApp(app, "POST", "/api/book/search/batch", {
        host,
        headers: { "X-Book-Session-Id": id },
        json: { sfens: [...new Array(2000).fill("startpos"), "invalid"] },
      });
      expect(response.status).toBe(400);
      expect(bookAPI.searchBookMoves).not.toHaveBeenCalled();
    } finally {
      bookSessionManager.close(id);
    }
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
      json: { usi: "7g7f", comment: "" },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(bookAPI.updateBookMove).not.toHaveBeenCalled();

    openResult.resolve("in-memory");
    await expect(openRequest).resolves.toMatchObject({ status: 200 });
    await expect(updateRequest).resolves.toMatchObject({ status: 200 });
    expect(bookAPI.updateBookMove).toHaveBeenCalledOnce();
  });

  it("should allow different external sessions to run concurrently", async () => {
    bookSessionManager.get("parallel-client-b", true);
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
      json: { usi: "2g2f", comment: "" },
    });
    await expect(updateRequest).resolves.toMatchObject({ status: 200 });

    openResult.resolve("in-memory");
    await expect(openRequest).resolves.toMatchObject({ status: 200 });
  });

  it("should wait for an active batch search before closing the same session", async () => {
    bookSessionManager.get("batch-close-client", true);
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
    bookSessionManager.get("client-A", true);
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
      const response = await requestApp(app, "POST", "/api/book/clear", {
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
