import { Hono } from "hono";
import { createAnalysisJobRoutes } from "@/server/routes/analysis_jobs";
import { AnalysisJobManager } from "@/server/analysis/jobManager";
import { handleError } from "@/server/errors";
import type { AppEnv } from "@/server/hono";
import { FakeResearchEngine, requestFor } from "./helpers/analysis";

function setup() {
  const manager = new AnalysisJobManager(
    () => new FakeResearchEngine(),
    async () => ({ id: "test", name: "Test" }),
  );
  const app = new Hono<AppEnv>().route("/api/analysis-jobs", createAnalysisJobRoutes(manager));
  app.onError(handleError);
  const payload = requestFor();
  payload.serverInstanceId = manager.serverInstanceId;
  const post = (body: unknown = payload) =>
    app.request("/api/analysis-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { manager, app, payload, post };
}

describe("analysis job HTTP boundary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("accepts legacy requests without MultiPV settings and preserves engine defaults", async () => {
    const { payload, post, manager } = setup();
    const options = { ...payload.options } as Record<string, unknown>;
    delete options.overrideMultiPV;
    delete options.multiPV;
    const response = await post({ ...payload, options });
    expect(response.status).toBe(202);
    const status = await response.json();
    expect(manager.get(status.jobId).request.options).toMatchObject({
      overrideMultiPV: false,
      multiPV: 1,
    });
    await manager.close();
  });

  it.each([undefined, null, "3", "", 0, -1, 1.5, 11])(
    "rejects invalid explicit MultiPV %s without starting a job",
    async (multiPV) => {
      const { payload, post, manager } = setup();
      const response = await post({
        ...payload,
        options: { ...payload.options, overrideMultiPV: true, multiPV },
      });
      expect(response.status).toBe(400);
      expect(manager.list()).toEqual([]);
    },
  );

  it.each([1, 3, 10])(
    "freezes valid MultiPV %i and rejects conflicting retries",
    async (multiPV) => {
      const { payload, post, manager } = setup();
      const input = { ...payload, options: { ...payload.options, overrideMultiPV: true, multiPV } };
      const response = await post(input);
      expect(response.status).toBe(202);
      const status = await response.json();
      expect(manager.get(status.jobId).request.options).toMatchObject({
        overrideMultiPV: true,
        multiPV,
      });
      expect((await (await post(input)).json()).jobId).toBe(status.jobId);
      expect(
        (await post({ ...input, options: { ...input.options, multiPV: multiPV === 1 ? 2 : 1 } }))
          .status,
      ).toBe(409);
      await manager.close();
    },
  );

  it("ignores an inactive invalid count and rejects malformed override flags", async () => {
    const { payload, post, manager } = setup();
    for (const overrideMultiPV of [null, "true", 1])
      expect(
        (await post({ ...payload, options: { ...payload.options, overrideMultiPV } })).status,
      ).toBe(400);
    const response = await post({
      ...payload,
      options: { ...payload.options, overrideMultiPV: false, multiPV: "" },
    });
    expect(response.status).toBe(202);
    const status = await response.json();
    expect(manager.get(status.jobId).request.options).toMatchObject({
      overrideMultiPV: false,
      multiPV: 1,
    });
    await manager.close();
  });

  it("creates asynchronously, recovers by request, and exposes complete results after disconnect", async () => {
    const { app, payload, post } = setup();
    const first = await post();
    expect(first.status).toBe(202);
    const status = await first.json();
    expect(status.state).toBe("preparing");
    expect((await (await post()).json()).jobId).toBe(status.jobId);
    await vi.advanceTimersByTimeAsync(6000);
    const recovered = await app.request(`/api/analysis-jobs/by-request/${payload.requestId}`);
    expect(await recovered.json()).toMatchObject({ jobId: status.jobId, state: "completed" });
    const result = await (await app.request(`/api/analysis-jobs/${status.jobId}/result`)).json();
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(
      await (
        await app.request(
          `/api/analysis-jobs/${status.jobId}/result?afterRevision=${result.revision}`,
        )
      ).json(),
    ).toMatchObject({ nodes: [] });
    expect(await (await app.request(`/api/analysis-jobs/${status.jobId}/source`)).json()).toEqual(
      JSON.parse(JSON.stringify(payload.source)),
    );
  });

  it("rejects conflicting retries, concurrent starts, stale server identities and unknown jobs", async () => {
    const { app, payload, post, manager } = setup();
    const accepted = await post();
    const status = await accepted.json();
    expect(
      (await post({ ...payload, options: { ...payload.options, descending: true } })).status,
    ).toBe(409);
    expect((await post({ ...payload, requestId: "new" })).status).toBe(503);
    expect((await post({ ...payload, serverInstanceId: "old" })).status).toBe(410);
    expect((await app.request("/api/analysis-jobs/unknown")).status).toBe(410);
    const cancel = () =>
      app.request(`/api/analysis-jobs/${status.jobId}/cancel`, { method: "POST" });
    expect((await cancel()).status).toBe(202);
    expect((await cancel()).status).toBe(202);
    await vi.advanceTimersByTimeAsync(0);
    await manager.close();
  });

  it.each([null, [], {}, { source: null }])("rejects malformed JSON shapes %j", async (value) => {
    expect((await setup().post(value)).status).toBe(400);
  });

  it("rejects invalid ranges, NaN-like values, trees, options and query counters", async () => {
    const { app, payload, post } = setup();
    expect(
      (
        await post({
          ...payload,
          options: { ...payload.options, perMoveCriteria: { maxSeconds: "1" } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ ...payload, options: { ...payload.options, engineId: "test\nquit" } })).status,
    ).toBe(400);
    const broken = structuredClone(payload);
    broken.source.nodes[1].parentId = broken.source.nodes[1].id;
    expect((await post(broken)).status).toBe(400);
    expect((await app.request("/api/analysis-jobs/unknown/result?afterRevision=-1")).status).toBe(
      400,
    );
    expect(
      (await app.request("/api/analysis-jobs/unknown/result?afterRevision=Infinity")).status,
    ).toBe(400);
  });

  it("rejects malformed and oversized bodies without starting an engine", async () => {
    const { app } = setup();
    const headers = { "Content-Type": "application/json" };
    expect(
      (await app.request("/api/analysis-jobs", { method: "POST", headers, body: "{" })).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/analysis-jobs", {
          method: "POST",
          headers,
          body: " ".repeat(10 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
  });
});
