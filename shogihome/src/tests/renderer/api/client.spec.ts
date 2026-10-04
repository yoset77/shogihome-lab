import { ApiResponseError, assertOkResponse, parseJsonResponse } from "@/renderer/api/client";

describe("API retry metadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["parseJsonResponse", parseJsonResponse],
    ["assertOkResponse", assertOkResponse],
  ] as const)("preserves Retry-After for failed responses with %s", async (_name, parse) => {
    const response = new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "120" },
    });
    await expect(parse(response)).rejects.toMatchObject({
      status: 429,
      message: "rate limited",
      retryAfterMs: 120_000,
    });
  });

  it.each([
    ["Sun, 04 Oct 2026 00:02:00 GMT", 120_000],
    ["Sun, 04 Oct 2026 00:00:00 GMT", 0],
    ["Sat, 03 Oct 2026 23:59:59 GMT", 0],
    ["0", 0],
    [" 30 ", 30_000],
    ["", undefined],
    ["invalid", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["Infinity", undefined],
    ["9".repeat(400), undefined],
  ])("decodes Retry-After %j as %s milliseconds", async (header, retryAfterMs) => {
    const response = new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": header },
    });
    const error = await parseJsonResponse(response).catch((error) => error);
    expect(error).toBeInstanceOf(ApiResponseError);
    if (!(error instanceof ApiResponseError)) throw error;
    expect(error.retryAfterMs).toBe(retryAfterMs);
  });

  it("keeps errors without retry metadata compatible", async () => {
    const response = new Response("expired", { status: 410 });
    const error = await parseJsonResponse(response).catch((error) => error);
    expect(error).toBeInstanceOf(ApiResponseError);
    if (!(error instanceof ApiResponseError)) throw error;
    expect(error).toMatchObject({ status: 410, message: "expired" });
    expect(error.retryAfterMs).toBeUndefined();
  });
});
