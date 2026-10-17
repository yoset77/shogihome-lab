import { Record } from "tsshogi";
import { Language, setLanguage, t } from "@/common/i18n";
import { getTranslationTable } from "@/common/i18n/translation_table";
import { MAX_MULTIPV } from "@/common/engine/relay_protocol";
import { AnalysisJob, ANALYSIS_MAX_RUNTIME_MS } from "@/server/analysis/job";
import { AnalysisJobManager } from "@/server/analysis/jobManager";
import { CommentBehavior } from "@/common/settings/comment";
import { restoreRecord } from "@/common/record/snapshot";
import { HttpError } from "@/server/errors";
import { FakeResearchEngine, requestFor } from "./helpers/analysis";
import { USI_PV_ENDS } from "@/common/game/usi";
import { decodeAnalysisStatus } from "@/common/analysis/types";

const config = async () => ({ id: "test", name: "my usi engine" });
const basicComment = (score: number) => `互角\n#評価値=${score}\n#エンジン=my usi engine\n`;

describe("server analysis jobs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("sets MultiPV once only when override is %s", async (overrideMultiPV) => {
    const engine = new FakeResearchEngine();
    const request = requestFor();
    request.options.overrideMultiPV = overrideMultiPV;
    request.options.multiPV = 3;
    const job = new AnalysisJob("job", request, engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(6000);
    await job.completion;
    expect(job.status().state).toBe("completed");
    if (overrideMultiPV) {
      expect(engine.setMultiPV).toHaveBeenCalledExactlyOnceWith(3);
      expect(engine.setMultiPV.mock.invocationCallOrder[0]).toBeGreaterThan(
        engine.launch.mock.invocationCallOrder[0],
      );
      expect(engine.setMultiPV.mock.invocationCallOrder[0]).toBeLessThan(
        engine.readyNewGame.mock.invocationCallOrder[0],
      );
    } else expect(engine.setMultiPV).not.toHaveBeenCalled();
  });

  it("cleans up a failed MultiPV setup without starting a search", async () => {
    const engine = new FakeResearchEngine();
    engine.setMultiPV.mockImplementation(() => {
      throw new Error("Engine unavailable");
    });
    const request = requestFor();
    request.options.overrideMultiPV = true;
    request.options.multiPV = 3;
    const job = new AnalysisJob("job", request, engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(0);
    await job.completion;
    expect(job.status()).toMatchObject({ state: "failed", error: "engine" });
    expect(engine.positions).toEqual([]);
    expect(engine.close).toHaveBeenCalledOnce();
  });

  it.each([400, 423, 503])(
    "classifies startup HTTP %s as capacity only for 503",
    async (status) => {
      const engine = new FakeResearchEngine();
      engine.launch.mockRejectedValue(new HttpError(status, "Startup rejected"));
      const job = new AnalysisJob("job", requestFor(), engine, config);
      job.start();
      await vi.advanceTimersByTimeAsync(0);
      await job.completion;

      expect(job.status()).toMatchObject({
        state: "failed",
        error: status === 503 ? "capacity" : "engine",
      });
      expect(engine.positions).toEqual([]);
      expect(engine.close).toHaveBeenCalledOnce();
    },
  );

  it("reports preparation until the first search starts and preserves its initial output", async () => {
    const engine = new FakeResearchEngine();
    engine.prepareDelay = 2000;
    const job = new AnalysisJob("job", requestFor(), engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(1999);
    expect(job.status().state).toBe("preparing");
    expect(job.status().current?.nodeId).toBe("n0");
    await vi.advanceTimersByTimeAsync(1);
    expect(job.status().state).toBe("running");
    expect(job.status().current?.infos[0].scoreCP).toBe(10);
    expect(job.result().nodes[0].researchInfo?.score).toBe(10);
    job.cancel();
    await vi.advanceTimersByTimeAsync(0);
    await job.completion;
  });

  it.each([
    {
      descending: false,
      limits: false,
      expected: ["", basicComment(20), basicComment(30), basicComment(40), basicComment(50), ""],
    },
    {
      descending: true,
      limits: false,
      expected: ["", basicComment(40), basicComment(30), basicComment(20), basicComment(10), ""],
    },
    {
      descending: false,
      limits: true,
      expected: ["", "", basicComment(20), basicComment(30), basicComment(40), ""],
    },
    {
      descending: true,
      limits: true,
      expected: ["", "", basicComment(30), basicComment(20), basicComment(10), ""],
    },
  ])(
    "preserves analysis range and descending=$descending limits=$limits",
    async ({ descending, limits, expected }) => {
      const request = requestFor();
      request.options.descending = descending;
      request.options.startCriteria = { enableNumber: limits, number: 2 };
      request.options.endCriteria = { enableNumber: limits, number: 4 };
      const engine = new FakeResearchEngine();
      const job = new AnalysisJob("job", request, engine, config);
      job.start();
      await vi.advanceTimersByTimeAsync(6000);
      await job.completion;
      expect(job.status().state).toBe("completed");
      expect(engine.close).toHaveBeenCalledOnce();
      const { record, nodes } = restoreRecord(request.source);
      for (const entry of job.result().nodes) nodes.get(entry.id)!.comment = entry.comment;
      expect(record.moves.map((node) => node.comment)).toEqual(expected);
      expect(engine.positions).toHaveLength(limits ? 4 : 5);
    },
  );

  it.each([
    CommentBehavior.APPEND,
    CommentBehavior.INSERT,
    CommentBehavior.OVERWRITE,
    CommentBehavior.NONE,
  ])("preserves comment behavior %s and accuracy labels", async (behavior) => {
    const record = Record.newByUSI("position startpos moves 7g7f 3c3d 2g2f 8c8d 2f2e") as Record;
    record.goto(1);
    record.current.comment = "初手";
    record.goto(2);
    record.current.comment = "2手目";
    const request = requestFor(record);
    request.options.commentBehavior = behavior;
    const engine = new FakeResearchEngine();
    engine.scores = [10, -10, 200, -200, 400, -1000];
    const job = new AnalysisJob("job", request, engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(6001);
    await job.completion;
    const comments = [
      "互角\n#評価値=-10\n#エンジン=my usi engine\n",
      "【緩手】\n先手有望\n#評価値=200\n#エンジン=my usi engine\n",
      "【疑問手】\n後手有望\n#評価値=-200\n#エンジン=my usi engine\n",
      "【悪手】\n先手有利\n#評価値=400\n#エンジン=my usi engine\n",
      "【大悪手】\n後手優勢\n#評価値=-1000\n#エンジン=my usi engine\n",
    ];
    const initial = ["初手", "2手目", "", "", ""];
    const expected = comments.map((comment, i) =>
      behavior === CommentBehavior.NONE
        ? initial[i]
        : behavior === CommentBehavior.OVERWRITE
          ? comment
          : behavior === CommentBehavior.APPEND
            ? initial[i] + (initial[i] ? "\n" : "") + comment
            : comment + (initial[i] ? "\n" : "") + initial[i],
    );
    const byId = new Map(job.result().nodes.map((node) => [node.id, node.comment]));
    expect(request.source.selectedPath.slice(1).map((id) => byId.get(id))).toEqual(expected);
  });

  it("does not charge preparation or previous stop waiting to the next search", async () => {
    const engine = new FakeResearchEngine();
    engine.prepareDelay = 2000;
    engine.stopDelay = 2000;
    const job = new AnalysisJob("job", requestFor(), engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(2999);
    expect(job.status().completedPositions).toBe(0);
    expect(engine.stops).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2001);
    expect(job.status().completedPositions).toBe(1);
    expect(engine.positions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(engine.stops).toHaveBeenCalledTimes(1);
    job.cancel();
    await vi.advanceTimersByTimeAsync(2001);
    await job.completion;
  });

  it("cancels during preparation without starting a search", async () => {
    let ready!: () => void;
    const engine = new FakeResearchEngine();
    engine.launch.mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const request = requestFor();
    request.options.overrideMultiPV = true;
    request.options.multiPV = 3;
    const job = new AnalysisJob("job", request, engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(0);
    job.cancel();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    await job.completion;
    expect(engine.positions).toEqual([]);
    expect(engine.setMultiPV).not.toHaveBeenCalled();
    expect(job.status().state).toBe("cancelled");
    expect(engine.close).toHaveBeenCalledOnce();
  });

  it("retains partial results and ignores output after cancellation", async () => {
    const engine = new FakeResearchEngine();
    const job = new AnalysisJob("job", requestFor(), engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(1100);
    const revision = job.result().revision;
    job.cancel();
    engine.output!("info score cp 9999");
    await vi.advanceTimersByTimeAsync(0);
    await job.completion;
    expect(job.status().state).toBe("cancelled");
    expect(job.result().revision).toBe(revision);
    expect(job.result(revision).nodes).toEqual([]);
    expect(job.result().nodes.find((node) => node.id === "n1")?.comment).toBe("");
  });

  it.each([false, true])(
    "ignores cancellation during finishing without hiding cleanup failure=%s",
    async (cleanupFails) => {
      const cleanup = Promise.withResolvers<void>();
      const engine = new FakeResearchEngine();
      engine.close.mockImplementation(async () => {
        await cleanup.promise;
        if (cleanupFails) throw new Error("close failed");
      });
      const job = new AnalysisJob("job", requestFor(), engine, config);
      job.start();
      await vi.advanceTimersByTimeAsync(6000);
      const results = job.result();
      try {
        expect(job.status()).toMatchObject({
          state: "finishing",
          completedPositions: 5,
          totalPositions: 5,
        });
        job.cancel();
        job.cancel();
        expect(job.status().state).toBe("finishing");
        expect(engine.launch.mock.calls[0][2].aborted).toBe(false);
        expect(engine.cancellations).not.toHaveBeenCalled();
        expect(engine.close).toHaveBeenCalledOnce();
        expect(job.endedAt).toBeUndefined();
      } finally {
        cleanup.resolve();
        await job.completion;
      }
      expect(job.status()).toMatchObject({
        state: cleanupFails ? "failed" : "completed",
        completedPositions: 5,
        ...(cleanupFails ? { error: "engine" } : {}),
      });
      expect(job.result()).toEqual(results);
    },
  );

  it("preserves missing-info gaps, deeper existing evaluations and untouched branches", async () => {
    const record = Record.newByUSI("position startpos moves 7g7f 3c3d 2g2f") as Record;
    record.goto(1);
    record.append(record.position.createMoveByUSI("8c8d")!);
    record.current.comment = "other branch";
    record.current.customData = { playerSearchInfo: { score: 900 } };
    record.switchBranchByIndex(0);
    record.goto(0);
    record.current.customData = { researchInfo: { depth: 99, score: 900 } };
    const request = requestFor(record);
    const engine = new FakeResearchEngine();
    engine.scores = [10, undefined, 30, 40];
    const job = new AnalysisJob("job", request, engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(5000);
    await job.completion;
    expect(job.result().nodes.some((node) => node.id === "n0")).toBe(false);
    expect(job.result().nodes.find((node) => node.id === "n2")?.comment).toBe("");
    const branch = request.source.nodes.find((node) => node.comment === "other branch")!;
    expect(job.result().nodes.some((node) => node.id === branch.id)).toBe(false);
    expect(job.result().nodes.find((node) => node.id === "n3")?.comment).toBe(basicComment(40));
  });

  it("uses primary PV for accuracy and does not label the best move as a blunder", async () => {
    const engine = new FakeResearchEngine();
    engine.scores = [1000, -1000];
    const request = requestFor(Record.newByUSI("position startpos moves 7g7f") as Record);
    request.options.overrideMultiPV = true;
    request.options.multiPV = 3;
    const job = new AnalysisJob("job", request, engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(0);
    engine.output!("info multipv 1 depth 10 score cp 1000 pv 7g7f 3c3d");
    engine.output!("info multipv 2 depth 10 score cp -9999 pv 2g2f");
    await vi.advanceTimersByTimeAsync(2001);
    await job.completion;
    const comment = job.result().nodes.find((node) => node.id === "n1")!.comment;
    expect(comment).not.toContain("【");
    expect(comment).toContain("#評価値=-1000");
  });

  it("stores zero scores, merges score kinds atomically and bounds live PVs", async () => {
    const engine = new FakeResearchEngine();
    const job = new AnalysisJob("job", requestFor(), engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(0);
    engine.output!("info depth 10 score mate 3 lowerbound pv 7g7f");
    engine.output!("info score cp 0");
    engine.output!("info multipv 0 depth 15 score cp 9999");
    engine.output!("info multipv 9999 depth 15 score cp 9999");
    engine.output!("info depth NaN score cp 9999");
    for (let multipv = 2; multipv <= MAX_MULTIPV; multipv++)
      engine.output!(`info multipv ${multipv} depth 10 score cp 0`);
    expect(job.status().current?.infos).toHaveLength(MAX_MULTIPV);
    expect(job.status().current?.infos[0]).toMatchObject({
      scoreCP: 0,
      scoreMate: undefined,
      lowerbound: undefined,
    });
    expect(job.result().nodes[0].researchInfo).toMatchObject({
      score: 0,
      mate: undefined,
      lowerBound: undefined,
    });
    job.cancel();
    await vi.advanceTimersByTimeAsync(0);
    await job.completion;
  });

  it.each(USI_PV_ENDS)("round trips live %s without adding it to record snapshots", async (end) => {
    const engine = new FakeResearchEngine();
    const job = new AnalysisJob("job", requestFor(), engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(0);
    try {
      engine.output!(`info depth 10 score cp 0 lowerbound pv 7g7f ${end}`);
      expect(job.status().current?.infos[0]).toMatchObject({ pv: ["7g7f", end], scoreCP: 0 });
      expect(job.result().nodes[0].researchInfo?.pv?.map((move) => move.usi)).toEqual(["7g7f"]);
      engine.output!(`info depth 11 score cp 0 pv ${end}`);
      expect(job.result().nodes[0].researchInfo).toMatchObject({ score: 0, pv: [] });
      const status = job.status();
      expect(decodeAnalysisStatus(JSON.parse(JSON.stringify(status)))).toEqual({
        ok: true,
        value: status,
      });
    } finally {
      job.cancel();
      await vi.advanceTimersByTimeAsync(0);
      await job.completion;
    }
  });

  describe.each([
    { number: 1, sign: 1 },
    { number: 2, sign: -1 },
  ])("search scores at position $number", ({ number, sign }) => {
    it.each(["cp", "mate"])("normalizes %s scores and bounds atomically", async (kind) => {
      const engine = new FakeResearchEngine();
      const request = requestFor();
      request.options.startCriteria = { enableNumber: true, number };
      const job = new AnalysisJob("job", request, engine, config);
      job.start();
      await vi.advanceTimersByTimeAsync(0);
      try {
        engine.output!(`info depth 10 score ${kind} 100 lowerbound`);
        const bounded = {
          score: kind === "cp" ? sign * 100 : undefined,
          mate: kind === "mate" ? sign * 100 : undefined,
          lowerBound: sign === 1 ? true : undefined,
          upperBound: sign === -1 ? true : undefined,
        };
        expect(job.result().nodes[0].researchInfo).toMatchObject(bounded);
        expect(job.status().current?.infos[0]).toMatchObject({
          lowerbound: true,
          [kind === "cp" ? "scoreCP" : "scoreMate"]: 100,
        });

        engine.output!("info depth 11 nodes 200");
        expect(job.result().nodes[0].researchInfo).toMatchObject({ ...bounded, depth: 11 });

        const otherKind = kind === "cp" ? "mate" : "cp";
        engine.output!(`info score ${otherKind} 200 upperbound`);
        expect(job.result().nodes[0].researchInfo).toMatchObject({
          score: otherKind === "cp" ? sign * 200 : undefined,
          mate: otherKind === "mate" ? sign * 200 : undefined,
          lowerBound: sign === -1 ? true : undefined,
          upperBound: sign === 1 ? true : undefined,
        });

        engine.output!("info score cp 0");
        expect(job.result().nodes[0].researchInfo).toMatchObject({
          score: 0,
          mate: undefined,
          lowerBound: undefined,
          upperBound: undefined,
        });
      } finally {
        job.cancel();
        await vi.advanceTimersByTimeAsync(0);
        await job.completion;
      }
    });
  });

  it("freezes the comment language without changing the process-global translation", async () => {
    setLanguage(Language.EN);
    try {
      const request = requestFor(Record.newByUSI("position startpos moves 7g7f") as Record);
      request.options.language = Language.JA;
      const engine = new FakeResearchEngine();
      engine.scores = [1000, -1000];
      const job = new AnalysisJob("job", request, engine, config);
      job.start();
      await vi.advanceTimersByTimeAsync(2001);
      await job.completion;
      expect(job.result().nodes.find((node) => node.id === "n1")!.comment).toContain("【大悪手】");
      expect(t.blunder).toBe(getTranslationTable(Language.EN).blunder);
      expect(getTranslationTable(Language.JA).blunder).toBe("大悪手");
    } finally {
      setLanguage(Language.JA);
    }
  });

  it("does not require any browser connection to complete and reports cleanup failure", async () => {
    const engine = new FakeResearchEngine();
    engine.close.mockRejectedValue(new Error("close failed"));
    const job = new AnalysisJob("job", requestFor(), engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(6000);
    await job.completion;
    expect(job.status()).toMatchObject({ state: "failed", error: "engine", completedPositions: 5 });
    expect(job.result().nodes.length).toBeGreaterThan(0);
  });

  it("bounds the entire job lifetime", async () => {
    const engine = new FakeResearchEngine();
    engine.prepareDelay = ANALYSIS_MAX_RUNTIME_MS * 2;
    const job = new AnalysisJob("job", requestFor(), engine, config);
    job.start();
    await vi.advanceTimersByTimeAsync(ANALYSIS_MAX_RUNTIME_MS + 1);
    await job.completion;
    expect(job.status()).toMatchObject({ state: "failed", error: "deadline" });
    expect(engine.close).toHaveBeenCalledOnce();
  });

  it("deduplicates creation, limits concurrent work, and never recreates expired requests", async () => {
    const manager = new AnalysisJobManager(() => new FakeResearchEngine(), config);
    const request = requestFor();
    request.serverInstanceId = manager.serverInstanceId;
    const job = await manager.create(request);
    expect(await manager.create(request)).toBe(job);
    await expect(
      manager.create({ ...request, options: { ...request.options, descending: true } }),
    ).rejects.toThrow();
    await expect(manager.create({ ...request, requestId: "another" })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(6000);
    await job.completion;
    await vi.advanceTimersByTimeAsync(ANALYSIS_MAX_RUNTIME_MS);
    expect(() => manager.get(job.id)).toThrow();
    await expect(manager.create(request)).rejects.toThrow();
    await expect(
      manager.create({ ...request, requestId: "new", serverInstanceId: "old-server" }),
    ).rejects.toThrow();
  });

  it("keeps at most ten terminal jobs and freezes caller-owned input", async () => {
    const manager = new AnalysisJobManager(() => new FakeResearchEngine(), config);
    const ids: string[] = [];
    for (let index = 0; index < 11; index++) {
      const request = requestFor();
      request.serverInstanceId = manager.serverInstanceId;
      request.requestId = `request-${index}`;
      const job = await manager.create(request);
      ids.push(job.id);
      request.source.nodes[0].comment = "caller edit";
      expect(job.request.source.nodes[0].comment).toBe("");
      await vi.advanceTimersByTimeAsync(6000);
      await job.completion;
    }
    expect(() => manager.get(ids[0])).toThrow();
    expect(ids.slice(1).map((id) => manager.get(id).status().state)).toEqual(
      Array(10).fill("completed"),
    );
  });

  describe("admission before engine discovery", () => {
    function submit(manager: AnalysisJobManager, kind: "single" | "batch", requestId: string) {
      const request = { ...requestFor(), serverInstanceId: manager.serverInstanceId, requestId };
      return kind === "single"
        ? manager.create(request)
        : manager.createBatch({
            requestId,
            serverInstanceId: manager.serverInstanceId,
            planId: "unused-plan",
            options: request.options,
            skipAnalyzed: false,
            fileOptions: {
              autoDetect: true,
              returnCode: "\n",
              useCSAV3: false,
              useUTF8ForKifAndKi2: false,
            },
          });
    }

    it.each(["single", "batch"] as const)(
      "rejects %s requests without discovery when another job is active",
      async (kind) => {
        const resolver = vi.fn(config);
        const manager = new AnalysisJobManager(() => new FakeResearchEngine(), resolver);
        try {
          const job = await submit(manager, "single", "running");
          expect(await submit(manager, "single", "running")).toBe(job);
          resolver.mockClear();

          await expect(submit(manager, kind, "rejected")).rejects.toMatchObject({ status: 503 });
          expect(resolver).not.toHaveBeenCalled();
        } finally {
          await manager.close();
        }
      },
    );

    it.each(["single", "batch"] as const)(
      "rejects %s requests without discovery when the request ledger is full",
      async (kind) => {
        const resolver = vi.fn(config);
        const manager = new AnalysisJobManager(() => new FakeResearchEngine(), resolver);
        const { requests } = manager as unknown as {
          requests: Map<string, { hash: string; jobId: string }>;
        };
        for (let index = 0; index < 10_000; index++)
          requests.set(`expired-${index}`, { hash: "expired", jobId: "expired" });

        await expect(submit(manager, kind, "rejected")).rejects.toMatchObject({ status: 503 });
        expect(resolver).not.toHaveBeenCalled();
      },
    );

    it.each(["single", "batch"] as const)(
      "rechecks capacity after pending %s discovery",
      async (kind) => {
        const discovery = Promise.withResolvers<Awaited<ReturnType<typeof config>>>();
        const resolver = vi.fn(config).mockReturnValueOnce(discovery.promise);
        const manager = new AnalysisJobManager(() => new FakeResearchEngine(), resolver);
        const pending = submit(manager, kind, "pending");
        const rejected = expect(pending).rejects.toMatchObject({ status: 503 });
        try {
          await submit(manager, "single", "winner");
          discovery.resolve(await config());
          await rejected;
          expect(resolver).toHaveBeenCalledTimes(2);
          expect(manager.list()).toHaveLength(1);
        } finally {
          discovery.resolve(await config());
          await manager.close();
        }
      },
    );
  });
});
