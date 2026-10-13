// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Record } from "tsshogi";
import { BatchAnalysisFiles } from "@/server/analysis/files";
import { AnalysisJobManager } from "@/server/analysis/jobManager";
import { ANALYSIS_MAX_RUNTIME_MS } from "@/server/analysis/job";
import {
  exportRecordAsBuffer,
  detectRecordFileFormatByPath,
  importRecordFromBuffer,
  getStandardRecordFileFormats,
} from "@/common/file/record";
import { FakeResearchEngine, requestFor } from "./helpers/analysis";
import * as kifuIndex from "@/server/database/kifu_index";
import { Hono } from "hono";
import { createAnalysisJobRoutes } from "@/server/routes/analysis_jobs";
import { handleError } from "@/server/errors";
import type { BatchAnalysisJobRequest } from "@/common/analysis/batch";
import { t } from "@/common/i18n";

describe("server batch analysis", () => {
  let directory: string;
  let files: BatchAnalysisFiles;
  let manager: AnalysisJobManager;
  let engine: FakeResearchEngine;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "batch-analysis-"));
    files = new BatchAnalysisFiles(() => directory);
    engine = new FakeResearchEngine();
    manager = new AnalysisJobManager(
      () => engine,
      async () => ({ id: "test", name: "Test" }),
      files,
    );
  });
  afterEach(async () => {
    await manager.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function write(
    name: string,
    record = Record.newByUSI("position startpos moves 7g7f resign") as Record,
  ) {
    await fs.writeFile(
      path.join(directory, name),
      exportRecordAsBuffer(record, detectRecordFileFormatByPath(name)!, {}).data,
    );
  }
  async function start(skipAnalyzed = false, requestId = "batch-1", maxSeconds = 0) {
    const plan = await files.prepare({ kind: "folder", directory: "", subdirectories: true });
    return manager.createBatch({
      requestId,
      serverInstanceId: manager.serverInstanceId,
      planId: plan.planId,
      options: { ...requestFor().options, perMoveCriteria: { maxSeconds } },
      skipAnalyzed,
      fileOptions: {
        autoDetect: true,
        returnCode: "\n",
        useCSAV3: false,
        useUTF8ForKifAndKi2: false,
      },
    });
  }
  it("enumerates all six formats, fixes the list, and rejects unsafe folders", async () => {
    await fs.mkdir(path.join(directory, "sub"));
    for (const extension of ["kif", "KIFU", "ki2", "ki2u", "csa", "jkf", "sfen", "db"])
      await fs.writeFile(path.join(directory, `a.${extension}`), "");
    await write("sub/b.kifu");
    await fs.symlink(path.join(directory, "sub"), path.join(directory, "linked"));
    const plan = await files.prepare({ kind: "folder", directory: "", subdirectories: false });
    expect(plan.files).toHaveLength(6);
    await write("new.kifu");
    expect(files.get(plan.planId).files).toEqual(plan.files);
    await expect(
      files.prepare({ kind: "folder", directory: "../", subdirectories: true }),
    ).rejects.toThrow();
    await expect(
      files.prepare({ kind: "folder", directory: "linked", subdirectories: true }),
    ).rejects.toThrow();
  });
  it("loads, analyzes, and saves every supported format without conversion", async () => {
    engine.scores = Array.from({ length: 100 }, () => 20);
    const record = Record.newByUSI("position startpos moves 7g7f resign") as Record;
    for (const format of getStandardRecordFileFormats())
      await fs.writeFile(
        path.join(directory, `game${format}`),
        exportRecordAsBuffer(record, format, {}).data,
      );
    const job = await start();
    await job.completion;
    expect(job.status().batch).toMatchObject({ successTotal: 6, failedTotal: 0, skippedTotal: 0 });
    for (const format of getStandardRecordFileFormats()) {
      const saved = importRecordFromBuffer(
        await fs.readFile(path.join(directory, `game${format}`)),
        format,
      );
      expect(saved).toBeInstanceOf(Record);
      expect((saved as Record).moves[1].comment).toContain("#評価値=");
    }
  });
  it("does not launch an engine or rewrite files when every record is skipped", async () => {
    const record = Record.newByUSI("position startpos moves 7g7f") as Record;
    record.current.comment = "#評価値=50";
    await write("a.kifu", record);
    const before = await fs.readFile(path.join(directory, "a.kifu"));
    const job = await start(true);
    await job.completion;
    expect(job.status().batch).toMatchObject({ recordIndex: 0, skippedTotal: 1, successTotal: 0 });
    expect(engine.launch).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, "a.kifu"))).toEqual(before);
  });

  it("keeps target checks available by evicting the oldest retained plan", async () => {
    await write("a.kifu");
    const source = { kind: "folder" as const, directory: "", subdirectories: false };
    const oldest = await files.prepare(source);
    let newest = oldest;
    for (let index = 0; index < 10; index++) newest = await files.prepare(source);
    expect(newest.files).toEqual(["a.kifu"]);
    expect(files.get(newest.planId)).toEqual(newest);
    expect(() => files.get(oldest.planId)).toThrow(t.batchAnalysisPlanExpired);
  });

  it("retains confirmed plans when another target check fails", async () => {
    await write("a.kifu");
    const source = { kind: "folder" as const, directory: "", subdirectories: false };
    const plans = [];
    for (let index = 0; index < 10; index++) plans.push(await files.prepare(source));
    vi.spyOn(fs, "opendir").mockRejectedValueOnce(new Error("permission denied"));
    await expect(files.prepare(source)).rejects.toThrow("permission denied");
    for (const plan of plans) expect(files.get(plan.planId)).toEqual(plan);
  });

  it("keeps concurrent target checks bounded independently of retained plans", async () => {
    await write("a.kifu");
    const source = { kind: "folder" as const, directory: "", subdirectories: false };
    for (let index = 0; index < 10; index++) await files.prepare(source);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const openDirectory = fs.opendir.bind(fs);
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      await gate;
      return openDirectory(...args);
    });
    const pending = Array.from({ length: 10 }, () => files.prepare(source));
    try {
      await expect(files.prepare(source)).rejects.toThrow(t.analysisJobCapacity);
    } finally {
      release();
    }
    const plans = await Promise.all(pending);
    for (const plan of plans) expect(files.get(plan.planId)).toEqual(plan);
  });

  it("releases accepted plans while resolving creation retries through the request ledger", async () => {
    const record = Record.newByUSI("position startpos moves 7g7f") as Record;
    record.current.comment = "#評価値=50";
    await write("a.kifu", record);
    const job = await start(true);
    expect(() => files.get(job.batchRequest.planId)).toThrow(t.batchAnalysisPlanExpired);
    await job.completion;
    expect(await manager.createBatch(structuredClone(job.batchRequest))).toBe(job);
    await expect(manager.createBatch({ ...job.batchRequest, skipAnalyzed: false })).rejects.toThrow(
      t.analysisJobInvalid,
    );
    for (let index = 1; index <= 10; index++) {
      const next = await start(true, `batch-${index + 1}`);
      await next.completion;
      expect(next.status().state).toBe("completed");
    }
    expect(engine.launch).not.toHaveBeenCalled();
  });

  async function rejectsUnwritableBeforeAnalysis(name: string) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await write(name);
    const before = await fs.readFile(path.join(directory, name));
    const job = await start();
    await job.completion;
    expect(job.fileResults()).toEqual([{ index: 1, path: name, state: "failed", reason: "save" }]);
    expect(engine.launch).not.toHaveBeenCalled();
    expect(engine.positions).toEqual([]);
    expect(await fs.readFile(path.join(directory, name))).toEqual(before);
  }

  it.each([".hidden.kif", ".stversions/game.kifu"])(
    "rejects unwritable hidden path %s before launching the engine",
    rejectsUnwritableBeforeAnalysis,
  );

  it
    .skipIf(process.platform === "win32")
    .each(["対局: 先手.kif", "棋聖戦 第1局?.kif", 'a"b.csa', "退避: 対局/game.kifu"])(
    "rejects unwritable POSIX path %s before launching the engine",
    rejectsUnwritableBeforeAnalysis,
  );

  it.skipIf(process.platform === "win32")(
    "analyzes only writable records when a colon-named file precedes them",
    async () => {
      await write("a: 対局.kif");
      await write("b.kifu");
      const before = await fs.readFile(path.join(directory, "a: 対局.kif"));
      const job = await start();
      await job.completion;
      expect(job.status().batch).toMatchObject({ failedTotal: 1, successTotal: 1 });
      expect(job.fileResults()).toEqual([
        { index: 1, path: "a: 対局.kif", state: "failed", reason: "save" },
        { index: 2, path: "b.kifu", state: "saved", reason: undefined },
      ]);
      expect(engine.launch).toHaveBeenCalledOnce();
      expect(engine.readyNewGame).toHaveBeenCalledOnce();
      expect(engine.positions).toHaveLength(2);
      expect(await fs.readFile(path.join(directory, "a: 対局.kif"))).toEqual(before);
      expect(await fs.readFile(path.join(directory, "b.kifu"), "utf8")).toContain("#評価値=");
    },
  );
  it("rejects oversized searches rather than silently truncating them", async () => {
    vi.spyOn(kifuIndex, "getKifuSearchFilePaths").mockReturnValue(
      Array.from({ length: 10_001 }, (_, index) => `${index}.kifu`),
    );
    await expect(files.prepare({ kind: "search", search: {} })).rejects.toThrow();
  });
  it("reuses one engine, saves each record, and shares the single-analysis execution slot", async () => {
    await write("a.kifu");
    await write("b.kifu");
    const job = await start();
    await expect(
      manager.create({ ...requestFor(), serverInstanceId: manager.serverInstanceId }),
    ).rejects.toThrow();
    await job.completion;
    expect(job.status().batch).toMatchObject({ successTotal: 2, failedTotal: 0, skippedTotal: 0 });
    expect(engine.launch).toHaveBeenCalledTimes(1);
    expect(engine.readyNewGame).toHaveBeenCalledTimes(2);
    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(directory, "a.kifu"), "utf8")).toContain("#評価値=");
    expect(manager.list()).toHaveLength(1);
  });
  it("continues after broken input and skips comments in variations like upstream", async () => {
    const record = Record.newByUSI("position startpos moves 7g7f 3c3d") as Record;
    record.goto(0);
    record.append(record.position.createMoveByUSI("2g2f")!);
    record.current.comment = "#評価値=50";
    await write("analyzed.kifu", record);
    await fs.writeFile(path.join(directory, "broken.jkf"), "not a record");
    await write("raw.kifu");
    const job = await start(true);
    await job.completion;
    expect(job.status().batch).toMatchObject({ successTotal: 1, failedTotal: 1, skippedTotal: 1 });
  });
  it("uses all matching index paths rather than the displayed search limit", async () => {
    const matches = Array.from({ length: 150 }, (_, index) => `game-${index}.kifu`);
    const search = vi.spyOn(kifuIndex, "getKifuSearchFilePaths").mockReturnValue(matches);
    const plan = await files.prepare({ kind: "search", search: { player1: "Player" } });
    expect(plan.files).toEqual(matches);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ player1: "Player" }), {
      strict: true,
      limit: 10_000,
    });
    search.mockImplementation(() => {
      throw new Error("index failed");
    });
    await expect(files.prepare({ kind: "search", search: {} })).rejects.toThrow("index failed");
  });
  it("fixes targets before starting but reads each record only when it is processed", async () => {
    await write("a.kifu");
    await write("b.kifu");
    const plan = await files.prepare({ kind: "folder", directory: "", subdirectories: true });
    const originalSave = files.save.bind(files);
    vi.spyOn(files, "save").mockImplementationOnce(async (...args) => {
      await originalSave(...args);
      await write("b.kifu", Record.newByUSI("position startpos moves 2g2f resign") as Record);
      await write("new.kifu");
    });
    const job = await manager.createBatch({
      requestId: "fixed-targets",
      serverInstanceId: manager.serverInstanceId,
      planId: plan.planId,
      options: { ...requestFor().options, perMoveCriteria: { maxSeconds: 0 } },
      skipAnalyzed: false,
      fileOptions: {
        autoDetect: true,
        returnCode: "\n",
        useCSAV3: false,
        useUTF8ForKifAndKi2: false,
      },
    });
    await job.completion;
    expect(job.fileResults().map((file) => file.path)).toEqual(["a.kifu", "b.kifu"]);
    expect(engine.positions).toHaveLength(4);
    expect(engine.positions[3]).toContain("2g2f");
    expect(await fs.readFile(path.join(directory, "new.kifu"), "utf8")).not.toContain("#評価値=");
  });
  it("rejects empty, expired, unreadable, and over-depth plans without a partial list", async () => {
    await expect(
      files.prepare({ kind: "folder", directory: "", subdirectories: true }),
    ).rejects.toThrow(t.batchAnalysisNoFiles);
    await write("a.kifu");
    const plan = await files.prepare({ kind: "folder", directory: "", subdirectories: true });
    vi.useFakeTimers();
    vi.setSystemTime(plan.expiresAt);
    expect(() => files.get(plan.planId)).toThrow(t.batchAnalysisPlanExpired);
    vi.useRealTimers();
    vi.spyOn(fs, "opendir").mockImplementationOnce(
      () => Promise.reject(new Error("permission denied")) as ReturnType<typeof fs.opendir>,
    );
    await expect(
      files.prepare({ kind: "folder", directory: "", subdirectories: true }),
    ).rejects.toThrow("permission denied");
    vi.mocked(fs.opendir).mockRestore();
    await fs.mkdir(path.join(directory, ...Array(11).fill("sub")), { recursive: true });
    await expect(
      files.prepare({ kind: "folder", directory: "", subdirectories: true }),
    ).rejects.toThrow();
  });
  it("analyzes only the main line and applies MultiPV once across files", async () => {
    const record = Record.newByUSI("position startpos moves 7g7f 3c3d") as Record;
    record.goto(0);
    record.append(record.position.createMoveByUSI("2g2f")!);
    await write("a.kifu", record);
    await write("b.kifu");
    const plan = await files.prepare({ kind: "folder", directory: "", subdirectories: true });
    const job = await manager.createBatch({
      requestId: "batch-pv",
      serverInstanceId: manager.serverInstanceId,
      planId: plan.planId,
      options: {
        ...requestFor().options,
        overrideMultiPV: true,
        multiPV: 3,
        perMoveCriteria: { maxSeconds: 0 },
      },
      skipAnalyzed: false,
      fileOptions: {
        autoDetect: true,
        returnCode: "\n",
        useCSAV3: false,
        useUTF8ForKifAndKi2: false,
      },
    });
    await job.completion;
    expect(engine.setMultiPV).toHaveBeenCalledExactlyOnceWith(3);
    expect(engine.positions.some((position) => position.includes("2g2f"))).toBe(false);
    expect(engine.positions).toHaveLength(5);
  });
  it("cancelled searches never save the current file or start the next one", async () => {
    await write("a.kifu");
    await write("b.kifu");
    const before = await fs.readFile(path.join(directory, "a.kifu"));
    let searching!: () => void;
    const started = new Promise<void>((resolve) => {
      searching = resolve;
    });
    const original = engine.startResearch.bind(engine);
    vi.spyOn(engine, "startResearch").mockImplementation(async (...args) => {
      const result = await original(...args);
      searching();
      return result;
    });
    const job = await start();
    await started;
    job.cancel();
    await job.completion;
    expect(job.status().state).toBe("cancelled");
    expect(job.status().batch?.successTotal).toBe(0);
    expect(await fs.readFile(path.join(directory, "a.kifu"))).toEqual(before);
    expect(engine.positions).toHaveLength(1);
    expect(engine.cancellations).toHaveBeenCalledOnce();
  });
  it("waits for an in-flight save after cancellation and does not process the next file", async () => {
    await write("a.kifu");
    await write("b.kifu");
    let entered!: () => void;
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const original = files.save.bind(files);
    vi.spyOn(files, "save").mockImplementationOnce(async (...args) => {
      entered();
      await wait;
      await original(...args);
    });
    const job = await start();
    await saving;
    let completed = false;
    void job.completion.then(() => {
      completed = true;
    });
    job.cancel();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(job.status().batch?.successTotal).toBe(0);
    finishSave();
    await job.completion;
    expect(job.status().batch?.successTotal).toBe(1);
    expect(job.status().state).toBe("cancelled");
    expect(engine.positions).toHaveLength(2);
  });

  describe("runtime limits", () => {
    const hourMs = 60 * 60 * 1000;
    const batchRuntimeMs = 14 * 24 * hourMs;
    const recordRuntimeMs = 13 * hourMs;
    beforeEach(() => vi.useFakeTimers());

    function nextRecord(): Promise<void> {
      return new Promise((resolve) => {
        engine.readyNewGame.mockImplementationOnce(() => resolve());
      });
    }
    async function writeLongRecords(count: number) {
      const moves = Array(3).fill("5i5h 5a5b 5h5i 5b5a").join(" ");
      const record = Record.newByUSI(`position startpos moves ${moves} resign`) as Record;
      for (let index = 1; index <= count; index++)
        await write(`${String(index).padStart(2, "0")}.kifu`, record);
    }

    it("continues past 24 hours when each record stays within its own limit", async () => {
      await writeLongRecords(2);
      const first = nextRecord();
      const job = await start(false, "long-batch", 3600);
      await first;
      const second = nextRecord();
      await vi.advanceTimersByTimeAsync(recordRuntimeMs);
      await second;
      await vi.advanceTimersByTimeAsync(ANALYSIS_MAX_RUNTIME_MS - recordRuntimeMs + 1);
      expect(job.status()).toMatchObject({
        state: "running",
        totalPositions: 13,
        batch: { successTotal: 1, processedFiles: 1 },
      });
      expect(job.status().error).toBeUndefined();
      expect(engine.cancellations).not.toHaveBeenCalled();
      expect(engine.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2 * hourMs);
      await job.completion;
      expect(job.status()).toMatchObject({ state: "completed", batch: { successTotal: 2 } });
      expect(engine.launch).toHaveBeenCalledOnce();
      expect(engine.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops at 14 days without saving the active record or starting pending records", async () => {
      await writeLongRecords(27);
      const before = await fs.readFile(path.join(directory, "26.kifu"));
      const pending = await fs.readFile(path.join(directory, "27.kifu"));
      const first = nextRecord();
      const job = await start(false, "batch-deadline", 3600);
      await first;
      for (let index = 0; index < 25; index++) {
        const next = nextRecord();
        await vi.advanceTimersByTimeAsync(recordRuntimeMs);
        expect(job.status().error).toBeUndefined();
        await next;
      }
      await vi.advanceTimersByTimeAsync(batchRuntimeMs - 25 * recordRuntimeMs - 1);
      expect(job.status()).toMatchObject({ state: "running", batch: { successTotal: 25 } });
      expect(engine.cancellations).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await job.completion;
      expect(job.status()).toMatchObject({
        state: "failed",
        error: "deadline",
        batch: { processedFiles: 25, successTotal: 25, failedTotal: 0 },
      });
      expect(
        job
          .fileResults()
          .slice(0, 25)
          .every((file) => file.state === "saved"),
      ).toBe(true);
      expect(job.fileResults().slice(25)).toEqual([
        { index: 26, path: "26.kifu", state: "cancelled" },
        { index: 27, path: "27.kifu", state: "pending" },
      ]);
      expect(await fs.readFile(path.join(directory, "01.kifu"), "utf8")).toContain("#評価値=");
      expect(await fs.readFile(path.join(directory, "26.kifu"))).toEqual(before);
      expect(await fs.readFile(path.join(directory, "27.kifu"))).toEqual(pending);
      expect(engine.readyNewGame).toHaveBeenCalledTimes(26);
      expect(engine.cancellations).toHaveBeenCalledOnce();
      expect(engine.close).toHaveBeenCalledOnce();
      expect(job.endedAt).toBe(job.createdAt + batchRuntimeMs);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("still stops an individual record at 24 hours", async () => {
      await write("a.kifu");
      await write("b.kifu");
      const before = await fs.readFile(path.join(directory, "a.kifu"));
      engine.prepareDelay = ANALYSIS_MAX_RUNTIME_MS * 2;
      const first = nextRecord();
      const job = await start();
      await first;
      await vi.advanceTimersByTimeAsync(ANALYSIS_MAX_RUNTIME_MS);
      await job.completion;
      expect(job.status()).toMatchObject({ state: "failed", error: "deadline" });
      expect(job.fileResults()).toEqual([
        { index: 1, path: "a.kifu", state: "failed", reason: "engine" },
        { index: 2, path: "b.kifu", state: "pending" },
      ]);
      expect(await fs.readFile(path.join(directory, "a.kifu"))).toEqual(before);
      expect(engine.positions).toHaveLength(1);
      expect(engine.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("waits for an in-flight save at the 14-day deadline and preserves its result", async () => {
      await write("a.kifu");
      await write("b.kifu");
      const before = await fs.readFile(path.join(directory, "b.kifu"));
      let entered!: () => void;
      let finishSave!: () => void;
      const saving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      const original = files.save.bind(files);
      vi.spyOn(files, "save").mockImplementationOnce(async (...args) => {
        entered();
        await wait;
        await original(...args);
      });
      const first = nextRecord();
      const job = await start();
      await first;
      await vi.advanceTimersByTimeAsync(1000);
      await saving;
      let completed = false;
      void job.completion.then(() => {
        completed = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(job.createdAt + batchRuntimeMs - Date.now() - 1);
        expect(job.status()).toMatchObject({ state: "running" });
        expect(job.status().error).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(job.status()).toMatchObject({
          state: "cancelling",
          error: "deadline",
          batch: { successTotal: 0 },
        });
        expect(completed).toBe(false);
        expect(engine.close).not.toHaveBeenCalled();
      } finally {
        finishSave();
        await job.completion;
      }
      expect(job.status()).toMatchObject({
        state: "failed",
        error: "deadline",
        batch: { successTotal: 1 },
      });
      expect(job.fileResults()).toEqual([
        { index: 1, path: "a.kifu", state: "saved", reason: undefined },
        { index: 2, path: "b.kifu", state: "pending" },
      ]);
      expect(await fs.readFile(path.join(directory, "a.kifu"), "utf8")).toContain("#評価値=");
      expect(await fs.readFile(path.join(directory, "b.kifu"))).toEqual(before);
      expect(engine.positions).toHaveLength(2);
      expect(engine.cancellations).not.toHaveBeenCalled();
      expect(engine.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("stops the batch on engine failure and leaves originals unchanged", async () => {
    await write("a.kifu");
    await write("b.kifu");
    vi.spyOn(engine, "startResearch").mockRejectedValue(new Error("engine failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const job = await start();
    await job.completion;
    expect(job.status()).toMatchObject({
      state: "failed",
      error: "engine",
      batch: { failedTotal: 1, successTotal: 0 },
    });
    expect(await fs.readFile(path.join(directory, "a.kifu"), "utf8")).not.toContain("#評価値=");
    expect(engine.close).toHaveBeenCalledOnce();
  });
  it("continues after save failure and records the reason", async () => {
    await write("a.kifu");
    await write("b.kifu");
    vi.spyOn(files, "save").mockRejectedValueOnce(new Error("disk failed"));
    const job = await start();
    await job.completion;
    expect(job.status()).toMatchObject({
      state: "completed",
      batch: { failedTotal: 1, successTotal: 1 },
    });
    const result = await new Hono()
      .route("/jobs", createAnalysisJobRoutes(manager))
      .request(`/jobs/${job.id}/files`);
    expect(await result.json()).toEqual([
      expect.objectContaining({ state: "failed", reason: "save" }),
      expect.objectContaining({ state: "saved" }),
    ]);
  });
  it("freezes creation retries and fences stale source/result requests at HTTP boundaries", async () => {
    await write("a.kifu");
    const plan = await files.prepare({ kind: "folder", directory: "", subdirectories: true });
    const input: BatchAnalysisJobRequest = {
      requestId: "retry",
      serverInstanceId: manager.serverInstanceId,
      planId: plan.planId,
      options: { ...requestFor().options, perMoveCriteria: { maxSeconds: 0 } },
      skipAnalyzed: false,
      fileOptions: {
        autoDetect: true,
        returnCode: "\n",
        useCSAV3: false,
        useUTF8ForKifAndKi2: false,
      },
    };
    const app = new Hono().route("/jobs", createAnalysisJobRoutes(manager)).onError(handleError);
    const post = (payload: unknown) =>
      app.request("/jobs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    const response = await post(input);
    expect(response.status).toBe(202);
    const status = await response.json();
    expect((await (await post(input)).json()).jobId).toBe(status.jobId);
    expect((await post({ ...input, skipAnalyzed: true })).status).toBe(409);
    await manager.get(status.jobId).completion;
    expect((await app.request(`/jobs/${status.jobId}/source?recordIndex=2`)).status).toBe(423);
    expect(
      (await app.request(`/jobs/${status.jobId}/result?recordIndex=2&afterRevision=9999`)).status,
    ).toBe(423);
    expect((await app.request(`/jobs/${status.jobId}/source?recordIndex=1`)).status).toBe(200);
    expect(
      (await app.request(`/jobs/${status.jobId}/source?recordIndex=999999999999999999999`)).status,
    ).toBe(400);
    expect((await app.request(`/jobs/${status.jobId}/result?recordIndex=`)).status).toBe(400);
    expect(
      (
        await post({
          ...input,
          requestId: "bad-pv",
          options: { ...input.options, overrideMultiPV: true, multiPV: 11 },
        })
      ).status,
    ).toBe(400);
  });
  it("rejects overwriting a file changed after reading", async () => {
    await write("a.kifu");
    const loaded = await files.load("a.kifu", true);
    await fs.writeFile(path.join(directory, "a.kifu"), "external edit");
    await expect(
      files.save(loaded, loaded.source, {
        autoDetect: true,
        returnCode: "\n",
        useCSAV3: false,
        useUTF8ForKifAndKi2: false,
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, "a.kifu"), "utf8")).toBe("external edit");
    expect(await fs.readdir(directory)).toEqual(["a.kifu"]);
  });
  it("rejects symlink aliases at the input boundary", async () => {
    await write("a.kifu");
    await fs.symlink(path.join(directory, "a.kifu"), path.join(directory, "alias.kifu"));
    await expect(files.load("alias.kifu", true)).rejects.toThrow("read");
  });
  it("detects replacement of a parent directory even when the file inode is preserved", async () => {
    await fs.mkdir(path.join(directory, "sub"));
    await write("sub/a.kifu");
    const loaded = await files.load("sub/a.kifu", true);
    await fs.rename(path.join(directory, "sub"), path.join(directory, "old"));
    await fs.mkdir(path.join(directory, "sub"));
    await fs.rename(path.join(directory, "old/a.kifu"), path.join(directory, "sub/a.kifu"));
    await expect(
      files.save(loaded, loaded.source, {
        autoDetect: true,
        returnCode: "\n",
        useCSAV3: false,
        useUTF8ForKifAndKi2: false,
      }),
    ).rejects.toThrow("changed");
  });
  it.each(["delete", "replace", "symlink"])(
    "rejects an original changed by %s without recreating or overwriting it",
    async (change) => {
      await write("a.kifu");
      const loaded = await files.load("a.kifu", true);
      await fs.unlink(path.join(directory, "a.kifu"));
      if (change === "replace") await write("a.kifu");
      if (change === "symlink") {
        await write("b.kifu");
        await fs.symlink(path.join(directory, "b.kifu"), path.join(directory, "a.kifu"));
      }
      await expect(
        files.save(loaded, loaded.source, {
          autoDetect: true,
          returnCode: "\n",
          useCSAV3: false,
          useUTF8ForKifAndKi2: false,
        }),
      ).rejects.toThrow("changed");
      if (change === "delete") expect(await fs.readdir(directory)).toEqual([]);
      if (change === "symlink")
        expect((await fs.lstat(path.join(directory, "a.kifu"))).isSymbolicLink()).toBe(true);
    },
  );
});
