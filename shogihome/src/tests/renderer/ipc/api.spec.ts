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
    const url = callArgs[0];
    expect(url).toBe("/api/book/save?path=" + encodeURIComponent("books/test.db"));
    expect(callArgs[1]).toHaveProperty("method", "POST");
    expect(callArgs[1]).toHaveProperty("signal");
  });

  it("rejects non-server-side book uri on save", async () => {
    const { default: api } = await import("@/renderer/ipc/api.js");

    await expect(api.saveBook("books/test.db")).rejects.toThrow(
      "Only server-side books are supported",
    );
  });
});
