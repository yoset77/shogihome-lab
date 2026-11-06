// @vitest-environment node
import { Hono } from "hono";
import {
  createRateLimiter,
  createKifuSearchRateLimiter,
  KIFU_SEARCH_RATE_LIMIT,
  KIFU_SEARCH_RATE_WINDOW_MS,
} from "@/server/security";

const client = vi.hoisted(() => ({ address: "client-one" }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: client.address } }),
}));

describe("shared HTTP rate limit", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("allows 6000 requests per IP across routes and returns Retry-After until 15 minutes pass", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TRUST_PROXY", "false");
    const app = new Hono().use("*", createRateLimiter()).get("*", (c) => c.text("ok"));
    let response = await app.request("/api/analysis-jobs");
    expect(response.headers.get("RateLimit-Limit")).toBe("6000");
    expect(response.headers.get("RateLimit-Policy")).toBe("6000;w=900");
    for (let index = 1; index < 6000; index++) {
      response = await app.request(index % 2 ? "/api/game-sessions" : "/api/analysis-jobs");
      expect(response.status).toBe(200);
    }
    const rejected = await app.request("/api/analysis-jobs");
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("900");
    client.address = "client-two";
    expect((await app.request("/api/analysis-jobs")).status).toBe(200);
    client.address = "client-one";
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect((await app.request("/api/analysis-jobs")).status).toBe(200);
  }, 20_000);

  it.each([false, true])(
    "expires the search budget and honors TRUST_PROXY=%s",
    async (trustProxy) => {
      vi.useFakeTimers();
      vi.stubEnv("TRUST_PROXY", String(trustProxy));
      client.address = "search-ip";
      const app = new Hono().use("*", createKifuSearchRateLimiter()).get("*", (c) => c.text("ok"));
      const request = (forwarded = "forwarded-one") =>
        app.request("/search", { headers: { "x-forwarded-for": forwarded } });
      for (let index = 0; index < KIFU_SEARCH_RATE_LIMIT; index++)
        expect((await request()).status).toBe(200);
      const rejected = await request();
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("Retry-After")).toBe(String(KIFU_SEARCH_RATE_WINDOW_MS / 1000));
      expect((await request("forwarded-two")).status).toBe(trustProxy ? 200 : 429);
      client.address = "other-search-ip";
      expect((await request()).status).toBe(trustProxy ? 429 : 200);
      client.address = "search-ip";
      await vi.advanceTimersByTimeAsync(KIFU_SEARCH_RATE_WINDOW_MS);
      expect((await request()).status).toBe(200);
    },
  );
});
