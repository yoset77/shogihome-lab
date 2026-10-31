// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { Record } from "tsshogi";
import { exportRecordAsBuffer, RecordFileFormat } from "@/common/file/record";
import { decodeAnalysisStatus } from "@/common/analysis/types";
import { decodeJobList } from "@/common/jobs/types";
import { MAX_BATCH_PARALLELISM, type BatchAnalysisJobRequest } from "@/common/analysis/batch";
import { t } from "@/common/i18n";
import { AnalysisJobManager } from "@/server/analysis/jobManager";
import { BatchAnalysisFiles } from "@/server/analysis/files";
import { ANALYSIS_MAX_RUNTIME_MS } from "@/server/analysis/job";
import { createAnalysisJobRoutes } from "@/server/routes/analysis_jobs";
import { handleError } from "@/server/errors";
import { resourceRegistry } from "@/server/engine/resources";
import { FakeResearchEngine, requestFor } from "./helpers/analysis";

describe("parallel batch analysis", () => {
  let directory: string;
  let files: BatchAnalysisFiles;
  let manager: AnalysisJobManager;
  let engines: FakeResearchEngine[];
  const config = { id: "test", name: "Test", threads: 4, resource: { groupId: "g" } };
  let createEngine: ReturnType<typeof vi.fn<() => FakeResearchEngine>>;
  let resolveEngine: ReturnType<typeof vi.fn<() => Promise<typeof config>>>;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "parallel-analysis-"));
    files = new BatchAnalysisFiles(() => directory);
    engines = [];
    createEngine = vi.fn(() => {
      const engine = new FakeResearchEngine();
      engine.scores = Array(100).fill(20 + engines.length);
      engines.push(engine);
      return engine;
    });
    resolveEngine = vi.fn(async () => structuredClone(config));
    manager = new AnalysisJobManager(createEngine, resolveEngine, files);
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 64 }]);
  });
  afterEach(async () => {
    await manager.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resourceRegistry.resetForTest();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function write(name: string, analyzed = false) {
    const record = Record.newByUSI("position startpos moves 7g7f resign") as Record;
    record.moves[1].comment = analyzed ? "#評価値=10" : `Original: ${name}`;
    await fs.writeFile(
      path.join(directory, name),
      exportRecordAsBuffer(record, RecordFileFormat.KIFU, {}).data,
    );
  }
  async function request(parallelism = 2): Promise<BatchAnalysisJobRequest> {
    const plan = await files.prepare({ kind: "folder", directory: "", subdirectories: false });
    return {
      requestId: "parallel-batch",
      serverInstanceId: manager.serverInstanceId,
      planId: plan.planId,
      parallelism,
      options: {
        ...requestFor().options,
        perMoveCriteria: { maxSeconds: 0 },
        overrideMultiPV: true,
        multiPV: 3,
      },
      skipAnalyzed: false,
      fileOptions: {
        autoDetect: true,
        returnCode: "\n",
        useCSAV3: false,
        useUTF8ForKifAndKi2: false,
      },
    };
  }

  function singleRequest(requestId: string) {
    const input = requestFor();
    input.requestId = requestId;
    input.serverInstanceId = manager.serverInstanceId;
    input.options.perMoveCriteria.maxSeconds = 60;
    return input;
  }

  async function fillOtherSlots() {
    return Promise.all(["other-1", "other-2"].map((id) => manager.create(singleRequest(id))));
  }

  it("bounds workers, dynamically distributes files, and reuses each engine", async () => {
    for (const name of ["a.kifu", "b.kifu", "c.kifu", "d.kifu", "e.kifu"]) await write(name);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const save = files.save.bind(files);
    const load = vi.spyOn(files, "load");
    vi.spyOn(files, "save").mockImplementation(async (...args) => {
      if (args[0].path === "a.kifu") {
        entered.resolve();
        await gate.promise;
      }
      await save(...args);
    });
    const input = await request();
    const job = await manager.createBatch(input);
    const workers = [...engines];
    const replacement = singleRequest("replacement");
    try {
      await entered.promise;
      await vi.waitFor(() => expect(job.status().batch?.processedFiles).toBe(4));
      expect(job.status()).toMatchObject({
        state: "running",
        current: null,
        batch: { parallel: { parallelism: 2, activeFiles: 1 } },
      });
      expect(engines).toHaveLength(2);
      expect(engines[0].readyNewGame).toHaveBeenCalledTimes(1);
      expect(engines[1].readyNewGame).toHaveBeenCalledTimes(4);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
      expect(manager.list()).toHaveLength(1);
      expect(decodeAnalysisStatus(job.status()).ok).toBe(true);
      expect(decodeJobList(manager.list()).ok).toBe(true);
      expect(await manager.createBatch(input)).toBe(job);
      await expect(manager.createBatch({ ...input, parallelism: 3 })).rejects.toThrow();
      await fillOtherSlots();
      await expect(manager.create(replacement)).rejects.toMatchObject({
        status: 503,
        message: t.analysisJobCapacity,
      });
    } finally {
      gate.resolve();
      await job.completion;
    }
    expect(job.status()).toMatchObject({
      state: "completed",
      batch: { successTotal: 5, parallel: { parallelism: 2, activeFiles: 0 } },
    });
    expect(load.mock.calls.map(([name]) => name).sort()).toEqual(
      job.fileResults().map((f) => f.path),
    );
    expect(resolveEngine).toHaveBeenCalledTimes(3);
    for (const engine of workers) {
      expect(engine.launch).toHaveBeenCalledOnce();
      expect(engine.launch.mock.calls[0][0]).toMatchObject({ threads: 4 });
      expect(engine.setMultiPV).toHaveBeenCalledExactlyOnceWith(3);
      expect(engine.close).toHaveBeenCalledOnce();
    }
    for (const file of job.fileResults()) {
      expect(file.state).toBe("saved");
      const text = await fs.readFile(path.join(directory, file.path), "utf8");
      expect(text).toContain(`Original: ${file.path}`);
      expect(text).toContain("#評価値=");
    }
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    await manager.create(replacement);
  });

  it("atomically rejects insufficient capacity before creating any worker", async () => {
    await write("a.kifu");
    await write("b.kifu");
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 7 }] });
    const input = await request();
    await expect(manager.createBatch(input)).rejects.toMatchObject({ status: 503 });
    expect(createEngine).not.toHaveBeenCalled();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(files.get(input.planId).files).toHaveLength(2);
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 8 }] });
    const job = await manager.createBatch(input);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    await job.completion;
    expect(job.status().state).toBe("completed");
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("shares three parent slots between parallel batches, serial batches and single analyses", async () => {
    await write("a.kifu");
    await write("b.kifu");
    const parallelInput = await request(2);
    parallelInput.options.perMoveCriteria.maxSeconds = 60;
    const parallel = await manager.createBatch(parallelInput);
    const serialInput = { ...(await request(1)), requestId: "serial" };
    serialInput.options.perMoveCriteria.maxSeconds = 60;
    const serial = await manager.createBatch(serialInput);
    const singleInput = {
      ...requestFor(),
      requestId: "single",
      serverInstanceId: manager.serverInstanceId,
    };
    singleInput.options.perMoveCriteria.maxSeconds = 60;
    const single = await manager.create(singleInput);
    await vi.waitFor(() =>
      expect(engines.map((engine) => engine.positions.length)).toEqual([1, 1, 1, 1]),
    );
    expect(manager.list()).toHaveLength(3);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(16);
    expect(await manager.createBatch(parallelInput)).toBe(parallel);
    expect(await manager.createBatch(serialInput)).toBe(serial);
    expect(await manager.create(singleInput)).toBe(single);
    await expect(manager.create({ ...singleInput, requestId: "fourth" })).rejects.toMatchObject({
      status: 503,
    });
    const nextBatch = { ...(await request()), requestId: "fourth-batch" };
    await expect(manager.createBatch(nextBatch)).rejects.toMatchObject({ status: 503 });
    parallel.cancel();
    await parallel.completion;
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    expect(serial.status().state).toBe("running");
    expect(single.status().state).toBe("running");
    for (const engine of engines.slice(2)) expect(engine.close).not.toHaveBeenCalled();
    await manager.create({ ...singleInput, requestId: "fourth" });
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(12);
  });

  it("reserves three pending batches and shares retries through out-of-order discovery", async () => {
    await write("a.kifu");
    await write("b.kifu");
    const inputs = await Promise.all(
      ["first", "second", "third"].map(async (requestId) => {
        const input = await request();
        input.requestId = requestId;
        input.options.perMoveCriteria.maxSeconds = 60;
        return input;
      }),
    );
    expect(new Set(inputs.map((input) => input.planId)).size).toBe(3);
    const gates = inputs.map(() => Promise.withResolvers<typeof config>());
    gates.forEach((gate) => resolveEngine.mockReturnValueOnce(gate.promise));
    const pending = inputs.map((input) => manager.createBatch(input));
    const retries = inputs.map((input) => manager.createBatch(input));
    const fourth = { ...inputs[0], requestId: "fourth" };
    try {
      await expect(manager.createBatch(fourth)).rejects.toMatchObject({
        status: 503,
        message: t.analysisJobCapacity,
      });
      await expect(manager.createBatch({ ...inputs[0], parallelism: 3 })).rejects.toMatchObject({
        status: 409,
      });
      expect(resolveEngine).toHaveBeenCalledTimes(3);
      expect(createEngine).not.toHaveBeenCalled();
      expect(manager.list()).toEqual([]);
      for (const index of [1, 2, 0]) {
        gates[index].resolve(config);
        const job = await pending[index];
        expect(await retries[index]).toBe(job);
        expect(job.request.requestId).toBe(inputs[index].requestId);
        await expect(manager.createBatch(fourth)).rejects.toMatchObject({
          status: 503,
          message: t.analysisJobCapacity,
        });
        expect(resolveEngine).toHaveBeenCalledTimes(3);
      }
      const jobs = await Promise.all(pending);
      expect(new Set(jobs.map((job) => job.id)).size).toBe(3);
      expect(manager.list()).toHaveLength(3);
      expect(createEngine).toHaveBeenCalledTimes(6);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(24);
    } finally {
      gates.forEach((gate) => gate.resolve(config));
      await Promise.allSettled([...pending, ...retries]);
    }
  });

  it.each(["single", "batch"] as const)(
    "rejects the other analysis kind for the same request ID while %s discovery is pending",
    async (kind) => {
      await write("a.kifu");
      const input = await request();
      input.options.perMoveCriteria.maxSeconds = 60;
      const single = singleRequest(input.requestId);
      const gate = Promise.withResolvers<typeof config>();
      resolveEngine.mockReturnValueOnce(gate.promise);
      const creating = kind === "single" ? manager.create(single) : manager.createBatch(input);
      const retry = kind === "single" ? manager.create(single) : manager.createBatch(input);
      try {
        const conflicting = kind === "single" ? manager.createBatch(input) : manager.create(single);
        await expect(conflicting).rejects.toMatchObject({
          status: 409,
          message: t.analysisJobInvalid,
        });
        expect(resolveEngine).toHaveBeenCalledOnce();
        expect(createEngine).not.toHaveBeenCalled();
        gate.resolve(config);
        const job = await creating;
        expect(await retry).toBe(job);
        expect(manager.list()).toHaveLength(1);
        expect(createEngine).toHaveBeenCalledOnce();
        expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
      } finally {
        gate.resolve(config);
        await Promise.allSettled([creating, retry]);
      }
    },
  );

  it("does not delete a newer pending reservation when an older batch admission rejects", async () => {
    await write("a.kifu");
    const input = await request();
    const gate = Promise.withResolvers<typeof config>();
    resolveEngine.mockReturnValueOnce(gate.promise);
    const creating = manager.createBatch(input);
    const rejected = expect(creating).rejects.toMatchObject({ status: 410 });
    const { pending } = manager as unknown as {
      pending: Map<string, { result: Promise<unknown> }>;
    };
    try {
      await vi.waitFor(() => expect(resolveEngine).toHaveBeenCalledOnce());
      const original = pending.get(input.requestId)!;
      const replacement = { ...original, result: Promise.resolve() };
      pending.set(input.requestId, replacement);
      files.release(input.planId);
      gate.resolve(config);
      await rejected;
      expect(pending.get(input.requestId)).toBe(replacement);
      expect(createEngine).not.toHaveBeenCalled();
    } finally {
      gate.resolve(config);
      await Promise.allSettled([creating]);
      pending.delete(input.requestId);
    }
  });

  it("does not allocate workers beyond the target count", async () => {
    await write("a.kifu");
    const job = await manager.createBatch(await request(MAX_BATCH_PARALLELISM));
    expect(createEngine).toHaveBeenCalledOnce();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    await job.completion;
    expect(job.backgroundOnly).toBe(true);
    expect(job.status()).toMatchObject({
      state: "completed",
      batch: { successTotal: 1, parallel: { parallelism: MAX_BATCH_PARALLELISM, activeFiles: 0 } },
    });
  });

  it("does not launch engines when all records are skipped", async () => {
    await write("a.kifu", true);
    await write("b.kifu", true);
    const job = await manager.createBatch({ ...(await request()), skipAnalyzed: true });
    await job.completion;
    expect(job.status()).toMatchObject({ state: "completed", batch: { skippedTotal: 2 } });
    for (const engine of engines) {
      expect(engine.launch).not.toHaveBeenCalled();
      expect(engine.close).toHaveBeenCalledOnce();
    }
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("cancels every active search without saving partial records or claiming pending files", async () => {
    for (const name of ["a.kifu", "b.kifu", "c.kifu"]) await write(name);
    const input = await request();
    input.options.perMoveCriteria.maxSeconds = 60;
    const job = await manager.createBatch(input);
    await vi.waitFor(() =>
      expect(engines.map((engine) => engine.positions.length)).toEqual([1, 1]),
    );
    expect(job.status().batch?.parallel?.activeFiles).toBe(2);
    job.cancel();
    job.cancel();
    await job.completion;
    expect(job.status()).toMatchObject({
      state: "cancelled",
      batch: { processedFiles: 0, parallel: { activeFiles: 0 } },
    });
    expect(job.fileResults().map((file) => file.state)).toEqual([
      "cancelled",
      "cancelled",
      "pending",
    ]);
    for (const engine of engines) {
      expect(engine.cancellations).toHaveBeenCalledOnce();
      expect(engine.close).toHaveBeenCalledOnce();
    }
    for (const name of ["a.kifu", "b.kifu", "c.kifu"])
      expect(await fs.readFile(path.join(directory, name), "utf8")).not.toContain("#評価値=");
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("waits for active file reads when cancelled before engine startup", async () => {
    for (const name of ["a.kifu", "b.kifu", "c.kifu"]) await write(name);
    const gate = Promise.withResolvers<void>();
    const load = files.load.bind(files);
    const loading = vi.spyOn(files, "load").mockImplementation(async (...args) => {
      await gate.promise;
      return load(...args);
    });
    const job = await manager.createBatch(await request());
    try {
      await vi.waitFor(() => expect(loading).toHaveBeenCalledTimes(2));
      job.cancel();
      expect(job.endedAt).toBeUndefined();
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    } finally {
      gate.resolve();
      await job.completion;
    }
    expect(job.status().state).toBe("cancelled");
    expect(job.fileResults().map((file) => file.state)).toEqual([
      "cancelled",
      "cancelled",
      "pending",
    ]);
    for (const engine of engines) expect(engine.launch).not.toHaveBeenCalled();
  });

  it("finishes an in-flight save while cancelling another worker's startup", async () => {
    for (const name of ["a.kifu", "b.kifu", "c.kifu"]) await write(name);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const save = files.save.bind(files);
    vi.spyOn(files, "save").mockImplementation(async (...args) => {
      entered.resolve();
      await gate.promise;
      await save(...args);
    });
    const job = await manager.createBatch(await request());
    engines[1].prepareDelay = 60_000;
    const workers = [...engines];
    const replacement = singleRequest("replacement");
    try {
      await entered.promise;
      await vi.waitFor(() => expect(engines[1].positions).toHaveLength(1));
      job.cancel();
      await vi.waitFor(() => expect(job.fileResults()[1].state).toBe("cancelled"));
      expect(job.status().state).toBe("cancelling");
      expect(job.endedAt).toBeUndefined();
      await fillOtherSlots();
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(16);
      for (const engine of workers) expect(engine.close).not.toHaveBeenCalled();
      await expect(manager.create(replacement)).rejects.toMatchObject({
        status: 503,
        message: t.analysisJobCapacity,
      });
    } finally {
      gate.resolve();
      await job.completion;
    }
    expect(job.fileResults().map((file) => file.state)).toEqual(["saved", "cancelled", "pending"]);
    expect(job.status()).toMatchObject({ state: "cancelled", batch: { successTotal: 1 } });
    expect(await fs.readFile(path.join(directory, "a.kifu"), "utf8")).toContain("#評価値=");
    expect(await fs.readFile(path.join(directory, "b.kifu"), "utf8")).not.toContain("#評価値=");
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    await manager.create(replacement);
  });

  it("stops the other workers on engine failure and preserves the failure cause", async () => {
    for (const name of ["a.kifu", "b.kifu", "c.kifu"]) await write(name);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = Promise.withResolvers<void>();
    const job = await manager.createBatch(await request());
    vi.spyOn(engines[0], "startResearch").mockImplementation(async () => {
      await gate.promise;
      throw new Error("Engine failed");
    });
    engines[1].prepareDelay = 60_000;
    try {
      await vi.waitFor(() => expect(engines[1].positions).toHaveLength(1));
    } finally {
      gate.resolve();
      await job.completion;
    }
    expect(job.status()).toMatchObject({
      state: "failed",
      error: "engine",
      batch: { successTotal: 0, failedTotal: 1 },
    });
    expect(job.fileResults().map((file) => file.state)).toEqual(["failed", "cancelled", "pending"]);
    for (const engine of engines) expect(engine.close).toHaveBeenCalledOnce();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("retains its parent slot until every engine has closed even when one cleanup fails", async () => {
    await write("a.kifu");
    await write("b.kifu");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const job = await manager.createBatch(await request());
    engines[0].close.mockRejectedValue(new Error("Cleanup failed"));
    engines[1].close.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
    });
    const workers = [...engines];
    const replacement = singleRequest("replacement");
    try {
      await entered.promise;
      expect(job.status().state).toBe("finishing");
      job.cancel();
      expect(job.endedAt).toBeUndefined();
      await fillOtherSlots();
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(16);
      await expect(manager.create(replacement)).rejects.toMatchObject({
        status: 503,
        message: t.analysisJobCapacity,
      });
    } finally {
      gate.resolve();
      await job.completion;
    }
    expect(job.status()).toMatchObject({ state: "failed", error: "engine" });
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    for (const engine of workers) expect(engine.close).toHaveBeenCalledOnce();
    await manager.create(replacement);
  });

  it("cancels all workers when an individual record reaches its deadline", async () => {
    await write("a.kifu");
    await write("b.kifu");
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const job = await manager.createBatch(await request());
    let count = 0;
    for (const engine of engines) {
      engine.prepareDelay = 2 * ANALYSIS_MAX_RUNTIME_MS;
      engine.readyNewGame.mockImplementation(() => {
        if (++count === 2) started.resolve();
      });
    }
    await started.promise;
    await vi.advanceTimersByTimeAsync(ANALYSIS_MAX_RUNTIME_MS);
    await job.completion;
    expect(job.status()).toMatchObject({ state: "failed", error: "deadline" });
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces background-only execution and supports idempotent cancellation through HTTP", async () => {
    await write("a.kifu");
    await write("b.kifu");
    const app = new Hono().route("/jobs", createAnalysisJobRoutes(manager)).onError(handleError);
    const input = await request();
    input.options.perMoveCriteria.maxSeconds = 60;
    const post = (url: string, payload?: unknown) =>
      app.request(url, {
        method: "POST",
        ...(payload === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
      });
    const response = await post("/jobs/batch", input);
    expect(response.status).toBe(202);
    const status = await response.json();
    const job = manager.get(status.jobId);
    expect(
      (
        await post(`/jobs/${job.id}/attach`, {
          ownerId: "owner",
          epoch: 0,
          takeover: false,
          screenId: "screen",
        })
      ).status,
    ).toBe(409);
    expect((await app.request(`/jobs/${job.id}/source`)).status).toBe(409);
    expect((await app.request(`/jobs/${job.id}/result`)).status).toBe(409);
    expect(job.attachment.status()).toEqual({ epoch: 0, generation: 0, attached: false });
    expect((await post(`/jobs/${job.id}/cancel`)).status).toBe(202);
    expect((await post(`/jobs/${job.id}/cancel`)).status).toBe(202);
    await job.completion;
    expect(job.status().state).toBe("cancelled");
    expect((await app.request(`/jobs/${job.id}/files`)).status).toBe(200);
    expect((await app.request(`/jobs/${job.id}/source`)).status).toBe(409);
    expect(
      (
        await post("/jobs/batch", {
          ...input,
          requestId: "invalid",
          parallelism: MAX_BATCH_PARALLELISM + 1,
        })
      ).status,
    ).toBe(400);
  });
});
