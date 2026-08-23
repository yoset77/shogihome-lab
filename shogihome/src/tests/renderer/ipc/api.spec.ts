import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = globalThis.fetch;

describe("renderer/ipc/api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ mode: "overwrite" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes server-side book uri to bridge on save", async () => {
    const { default: api } = await import("@/renderer/ipc/api.js");

    await api.saveBook("server://books/test.db", "session-1");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const mockFn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const callArgs = mockFn.mock.calls[0];
    const url = new URL(callArgs[0] as string);
    expect(url.pathname + url.search).toBe(
      "/api/book/save?path=" + encodeURIComponent("books/test.db"),
    );
    expect(callArgs[1]).toHaveProperty("method", "POST");
    expect(callArgs[1]).toHaveProperty("signal");
    expect((callArgs[1]?.headers as Headers).get("X-Book-Session-Id")).toBe("session-1");
  });

  it("passes JSON body through hono client init", async () => {
    const { default: api } = await import("@/renderer/ipc/api.js");

    await api.searchBookMovesBatch(["startpos"], "session-2");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const mockFn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const callArgs = mockFn.mock.calls[0];
    const url = new URL(callArgs[0] as string);
    expect(url.pathname).toBe("/api/book/search/batch");
    expect(callArgs[1]).toHaveProperty("method", "POST");
    expect(callArgs[1]).toHaveProperty("body", JSON.stringify({ sfens: ["startpos"] }));
    expect((callArgs[1]?.headers as Headers).get("Content-Type")).toBe("application/json");
    expect((callArgs[1]?.headers as Headers).get("X-Book-Session-Id")).toBe("session-2");
  });

  it("passes text body through hono client init", async () => {
    const { default: api } = await import("@/renderer/ipc/api.js");

    await api.saveRecordFileBackup("kif text");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const mockFn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const callArgs = mockFn.mock.calls[0];
    const url = new URL(callArgs[0] as string);
    expect(url.pathname).toBe("/api/history/backup");
    expect(callArgs[1]).toHaveProperty("method", "POST");
    expect(callArgs[1]).toHaveProperty("body", "kif text");
    expect((callArgs[1]?.headers as Headers).get("Content-Type")).toBe("text/plain");
  });

  it("serializes book move order as a query string", async () => {
    const { default: api } = await import("@/renderer/ipc/api.js");

    await api.updateBookMoveOrder("startpos", "7g7f", 2, "session-3");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const mockFn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const callArgs = mockFn.mock.calls[0];
    const url = new URL(callArgs[0] as string);
    expect(url.pathname).toBe("/api/book/order");
    expect(url.searchParams.get("sfen")).toBe("startpos");
    expect(url.searchParams.get("usi")).toBe("7g7f");
    expect(url.searchParams.get("order")).toBe("2");
    expect((callArgs[1]?.headers as Headers).get("X-Book-Session-Id")).toBe("session-3");
  });

  it("rejects non-server-side book uri on save", async () => {
    const { default: api } = await import("@/renderer/ipc/api.js");

    await expect(api.saveBook("books/test.db")).rejects.toThrow(
      "Only server-side books are supported",
    );
  });

  it("closes a generated book session when opening fails", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("open failed"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const { default: api } = await import("@/renderer/ipc/api.js");

    await expect(api.openBookAsNewSession("server://books/test.db", {})).rejects.toThrow(
      "open failed",
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const mockFn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const closeCall = mockFn.mock.calls[1];
    const closeUrl = new URL(closeCall[0] as string);
    expect(closeUrl.pathname).toBe("/api/book/close");
    expect(closeCall[1]).toHaveProperty("method", "POST");
  });
});
