// @vitest-environment node
import { Hono } from "hono";
import { createRateLimiter } from "@/server/security";

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
});
