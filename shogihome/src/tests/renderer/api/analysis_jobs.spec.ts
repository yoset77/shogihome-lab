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

  it("uses batch RPC paths and scopes source and result requests to the record index", async () => {
    const source = requestFor().source;
    const batch = {
      totalFiles: 1,
      processedFiles: 0,
      currentFile: 1,
      currentPath: "a.kifu",
      recordIndex: 1,
      recordPath: "a.kifu",
      saved: false,
      successTotal: 0,
      failedTotal: 0,
      skippedTotal: 0,
    };
    const status = {
      jobId: "batch",
      requestId: "request",
      serverInstanceId: "server",
      state: "running",
      engineName: "Test",
      completedPositions: 0,
      totalPositions: 1,
      resultRevision: 0,
      current: null,
      batch,
    };
    const calls: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      const payload = url.pathname.endsWith("/prepare")
        ? { planId: "plan", files: ["a.kifu"], expiresAt: 1 }
        : url.pathname.endsWith("/source")
          ? source
          : url.pathname.endsWith("/result")
            ? { jobId: "batch", serverInstanceId: "server", revision: 0, nodes: [], recordIndex: 1 }
            : url.pathname.endsWith("/files")
              ? [{ index: 1, path: "a.kifu", state: "pending" }]
              : status;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = createAnalysisJobsClient();
    expect(
      (await client.prepareBatch({ kind: "folder", directory: "", subdirectories: true })).files,
    ).toEqual(["a.kifu"]);
    await client.createBatch({
      requestId: "request",
      serverInstanceId: "server",
      planId: "plan",
      options: requestFor().options,
      skipAnalyzed: true,
      fileOptions: {
        autoDetect: true,
        returnCode: "\n",
        useCSAV3: false,
        useUTF8ForKifAndKi2: false,
      },
    });
    await client.source("batch", 1);
    await client.result("batch", 0, undefined, 1);
    await client.files("batch");
    expect(calls.map((url) => url.pathname)).toEqual([
      "/api/analysis-jobs/batch/prepare",
      "/api/analysis-jobs/batch",
      "/api/analysis-jobs/batch/source",
      "/api/analysis-jobs/batch/result",
      "/api/analysis-jobs/batch/files",
    ]);
    expect(calls[2].searchParams.get("recordIndex")).toBe("1");
    expect(calls[3].searchParams.get("recordIndex")).toBe("1");
  });

  it("lists retained jobs and transfers attachment without granting old owners cancellation", async () => {
    const { client, manager } = setup();
    const request = requestFor();
    request.serverInstanceId = manager.serverInstanceId;
    const status = await client.create(request);
    expect(await client.list()).toMatchObject([
      { id: status.jobId, kind: "analysis", attachment: { attached: false } },
    ]);
    const first = await client.attach(status.jobId, {
      ownerId: "first",
      screenId: "first",
      epoch: 0,
      takeover: false,
    });
    await expect(
      client.attach(status.jobId, {
        ownerId: "second",
        epoch: first.epoch,
        takeover: false,
        screenId: "second",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const second = await client.attach(status.jobId, {
      ownerId: "second",
      screenId: "second",
      epoch: first.epoch,
      takeover: true,
    });
    await expect(client.status(status.jobId, first)).rejects.toMatchObject({ status: 409 });
    await expect(client.result(status.jobId, 0, first)).rejects.toMatchObject({ status: 409 });
    await expect(client.cancel(status.jobId, first)).rejects.toMatchObject({ status: 409 });
    await expect(client.cancel(status.jobId)).rejects.toMatchObject({ status: 409 });
    await client.detach(status.jobId, first);
    expect((await client.status(status.jobId, second)).attachment?.epoch).toBe(second.epoch);
    await client.cancel(status.jobId, second);
    await vi.advanceTimersByTimeAsync(0);
    expect((await client.list())[0].state).toBe("cancelled");
  });
  it("requires the recovered screen to authorize an unchanged pending cancellation", async () => {
    const { client, manager } = setup();
    const request = requestFor();
    request.serverInstanceId = manager.serverInstanceId;
    const status = await client.create(request);
    const first = await client.attach(status.jobId, {
      ownerId: "owner",
      epoch: 0,
      screenId: "first",
      takeover: false,
    });
    manager.get(status.jobId).attachment.suspend(first);
    const current = await client.attach(status.jobId, {
      ...first,
      screenId: "second",
      takeover: false,
    });
    await expect(client.cancel(status.jobId, first, "cancel-request")).rejects.toMatchObject({
      status: 409,
    });
    expect(await client.cancelOutcome(status.jobId, "cancel-request")).toEqual({
      state: "unknown",
    });
    await client.cancel(status.jobId, first, "cancel-request", current);
    expect(await client.cancelOutcome(status.jobId, "cancel-request")).toEqual({
      state: "accepted",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await client.status(status.jobId)).state).toBe("cancelled");
  });
});
