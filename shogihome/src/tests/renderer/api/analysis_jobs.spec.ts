import { Hono } from "hono";
import { createAnalysisJobsClient } from "@/renderer/api/analysis_jobs";
import { ApiResponseError } from "@/renderer/api/client";
import { AnalysisJobManager } from "@/server/analysis/jobManager";
import { createAnalysisJobRoutes } from "@/server/routes/analysis_jobs";
import { handleError } from "@/server/errors";
import type { AppEnv } from "@/server/hono";
import { FakeResearchEngine, requestFor } from "@/tests/server/helpers/analysis";

describe("typed analysis HTTP client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup() {
    const manager = new AnalysisJobManager(
      () => new FakeResearchEngine(),
      async () => ({ id: "test", name: "Server engine" }),
    );
    const app = new Hono<AppEnv>().route("/api/analysis-jobs", createAnalysisJobRoutes(manager));
    app.onError(handleError);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      app.request(input, init),
    );
    return { client: createAnalysisJobsClient(), manager };
  }

  it("uses the real RPC route paths and validates all recovery responses", async () => {
    const { client, manager } = setup();
    const capabilities = await client.capabilities();
    expect(capabilities.serverInstanceId).toBe(manager.serverInstanceId);
    const request = requestFor();
    request.serverInstanceId = capabilities.serverInstanceId;
    const status = await client.create(request);
    expect((await client.byRequest(request.requestId)).jobId).toBe(status.jobId);
    expect(await client.source(status.jobId)).toEqual(JSON.parse(JSON.stringify(request.source)));
    await vi.advanceTimersByTimeAsync(6000);
    expect((await client.status(status.jobId)).state).toBe("completed");
    const result = await client.result(status.jobId, 0);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect((await client.result(status.jobId, result.revision)).nodes).toEqual([]);
  });

  it("preserves expiry errors and cancels through the same RPC client", async () => {
    const { client, manager } = setup();
    await expect(client.status("expired")).rejects.toMatchObject({ status: 410 });
    try {
      await client.status("expired");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiResponseError);
    }
    const request = requestFor();
    request.serverInstanceId = manager.serverInstanceId;
    const status = await client.create(request);
    await client.cancel(status.jobId);
    await vi.advanceTimersByTimeAsync(0);
    expect((await client.status(status.jobId)).state).toBe("cancelled");
  });

  it("does not trust a successful HTTP response with invalid JSON shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ state: "running" }), { status: 200 }),
    );
    await expect(createAnalysisJobsClient().status("job")).rejects.toThrow();
  });
});
