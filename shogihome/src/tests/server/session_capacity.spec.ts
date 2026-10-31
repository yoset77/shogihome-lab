// @vitest-environment node
import { AnalysisJobManager } from "@/server/analysis/jobManager";
import { GameSessionManager } from "@/server/game/manager";
import { resourceRegistry } from "@/server/engine/resources";
import { decodeJobList } from "@/common/jobs/types";
import { FakeResearchEngine, requestFor } from "./helpers/analysis";
import { fakeGamePlayer, gameRequest } from "./helpers/game";

describe("server session capacity", () => {
  let games: GameSessionManager;
  let analysis: AnalysisJobManager;
  let players: ReturnType<typeof fakeGamePlayer>[];
  let engines: FakeResearchEngine[];
  const config = { id: "test", name: "Test", threads: 1, resource: { groupId: "g" } };
  let resolveEngine: ReturnType<typeof vi.fn<() => Promise<typeof config>>>;
  let saveBackup: ReturnType<typeof vi.fn<(kif: string) => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 12 }]);
    players = [];
    engines = [];
    saveBackup = vi.fn(async () => {});
    games = new GameSessionManager({
      playerBuilder: {
        build: async () => {
          const fake = fakeGamePlayer();
          players.push(fake);
          return fake.player;
        },
      },
      acquireResourceLease: async () => resourceRegistry.acquire({ groupId: "g", cost: 1 }),
      saveBackup,
    });
    resolveEngine = vi.fn(async () => structuredClone(config));
    analysis = new AnalysisJobManager(() => {
      const engine = new FakeResearchEngine();
      engines.push(engine);
      return engine;
    }, resolveEngine);
  });
  afterEach(async () => {
    const closing = Promise.all([games.close(), analysis.close()]);
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    resourceRegistry.resetForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function gameInput(requestId: string) {
    const request = gameRequest();
    request.requestId = requestId;
    request.serverInstanceId = games.serverInstanceId;
    request.settings.black = { uri: "lan-engine:test", name: "Black" };
    request.settings.white = { uri: "lan-engine:test", name: "White" };
    return request;
  }
  function analysisInput(requestId: string) {
    return { ...requestFor(), requestId, serverInstanceId: analysis.serverInstanceId };
  }

  it("runs three games and three analyses independently without mixing results or releasing other owners", async () => {
    const gameRequests = ["game-1", "game-2", "game-3"].map(gameInput);
    const analysisRequests = ["analysis-1", "analysis-2", "analysis-3"].map(analysisInput);
    const sessions = await Promise.all(gameRequests.map((request) => games.create(request)));
    const jobs = await Promise.all(analysisRequests.map((request) => analysis.create(request)));
    await vi.advanceTimersByTimeAsync(0);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(6);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(3);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(3);
    expect(decodeJobList(games.list()).ok).toBe(true);
    expect(decodeJobList(analysis.list()).ok).toBe(true);
    await expect(games.create(gameInput("game-4"))).rejects.toMatchObject({ status: 503 });
    await expect(analysis.create(analysisInput("analysis-4"))).rejects.toMatchObject({
      status: 503,
    });
    expect(await games.create(gameRequests[0])).toBe(sessions[0]);
    expect(await analysis.create(analysisRequests[0])).toBe(jobs[0]);
    engines.forEach((engine, index) => engine.output!(`info score cp ${100 + index}`));
    expect(jobs.map((job) => job.status().current?.infos[0].scoreCP)).toEqual([100, 101, 102]);
    expect(jobs.map((job) => job.result().nodes[0].researchInfo?.score)).toEqual([100, 101, 102]);

    jobs[0].cancel();
    const closing = sessions[0].close();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([closing, jobs[0].completion]);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    for (const session of sessions.slice(1)) expect(session.snapshot().state).toBe("running");
    for (const job of jobs.slice(1)) expect(job.status().state).toBe("running");
    for (const engine of engines.slice(1)) expect(engine.close).not.toHaveBeenCalled();
    await games.create(gameInput("game-4"));
    await analysis.create(analysisInput("analysis-4"));
    await vi.advanceTimersByTimeAsync(0);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(6);
  });

  it("holds a game slot through saving and player cleanup before accepting its replacement", async () => {
    const sessions = await Promise.all(
      ["first", "second", "third"].map((id) => games.create(gameInput(id))),
    );
    await vi.advanceTimersByTimeAsync(0);
    const saving = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    saveBackup.mockImplementationOnce(() => saving.promise);
    players[0].player.close = vi.fn(() => cleanup.promise);
    const closing = sessions[0].close();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(saveBackup).toHaveBeenCalledOnce();
      expect(sessions[0].endedAt).toBeUndefined();
      await expect(games.create(gameInput("replacement"))).rejects.toMatchObject({ status: 503 });
      saving.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(players[0].player.close).toHaveBeenCalledOnce();
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(3);
      await expect(games.create(gameInput("replacement"))).rejects.toMatchObject({ status: 503 });
    } finally {
      saving.resolve();
      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await closing;
    }
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(2);
    await games.create(gameInput("replacement"));
    for (const session of sessions.slice(1)) expect(session.snapshot().state).toBe("running");
  });

  it("checks capacity without generating game snapshots or analysis status payloads", async () => {
    const sessions = await Promise.all(
      ["first", "second", "third"].map((id) => games.create(gameInput(id))),
    );
    const jobs = await Promise.all(
      ["first", "second", "third"].map((id) => analysis.create(analysisInput(id))),
    );
    await vi.advanceTimersByTimeAsync(0);
    const snapshots = sessions.map((session) => vi.spyOn(session, "snapshot"));
    const statuses = jobs.map((job) => vi.spyOn(job, "status"));
    await expect(games.create(gameInput("fourth"))).rejects.toMatchObject({ status: 503 });
    await expect(analysis.create(analysisInput("fourth"))).rejects.toMatchObject({ status: 503 });
    for (const snapshot of snapshots) expect(snapshot).not.toHaveBeenCalled();
    for (const status of statuses) expect(status).not.toHaveBeenCalled();
  });

  it("keeps the shared CPU budget authoritative even while the independent job limits have space", async () => {
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 4 }] });
    const sessions = await Promise.all(
      ["first", "second", "third"].map((id) => games.create(gameInput(id))),
    );
    const job = await analysis.create(analysisInput("first"));
    await vi.advanceTimersByTimeAsync(0);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    const rejected = analysisInput("second");
    await expect(analysis.create(rejected)).rejects.toMatchObject({ status: 503 });
    expect(analysis.list()).toHaveLength(1);
    expect(engines).toHaveLength(1);
    const closing = sessions[0].close();
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    await analysis.create(rejected);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    expect(job.status().state).toBe("running");
    expect(engines[0].close).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "holds an analysis slot until cleanup converges (failure=%s)",
    async (fail) => {
      const jobs = await Promise.all(
        ["first", "second", "third"].map((id) => analysis.create(analysisInput(id))),
      );
      await vi.advanceTimersByTimeAsync(0);
      const cleanup = Promise.withResolvers<void>();
      vi.spyOn(console, "error").mockImplementation(() => {});
      engines[0].close.mockImplementation(async () => {
        await cleanup.promise;
        if (fail) throw new Error("Cleanup failed");
      });
      jobs[0].cancel();
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(engines[0].close).toHaveBeenCalledOnce();
        expect(jobs[0].endedAt).toBeUndefined();
        expect(resourceRegistry.groupSnapshot()[0].used).toBe(3);
        await expect(analysis.create(analysisInput("replacement"))).rejects.toMatchObject({
          status: 503,
        });
        expect(await analysis.create(analysisInput("first"))).toBe(jobs[0]);
      } finally {
        cleanup.resolve();
        await jobs[0].completion;
      }
      expect(jobs[0].status().state).toBe(fail ? "failed" : "cancelled");
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(2);
      await analysis.create(analysisInput("replacement"));
      for (const job of jobs.slice(1)) expect(job.status().state).toBe("running");
    },
  );

  it("reserves three pending analysis slots, freezes inputs and shares retries through out-of-order discovery", async () => {
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<typeof config>());
    gates.forEach((gate) => resolveEngine.mockImplementationOnce(() => gate.promise));
    const requests = ["first", "second", "third"].map(analysisInput);
    const pending = requests.map((request) => analysis.create(request));
    const retry = analysis.create(requests[0]);
    try {
      await expect(analysis.create(analysisInput("fourth"))).rejects.toMatchObject({ status: 503 });
      await expect(
        analysis.create({ ...requests[0], options: { ...requests[0].options, descending: true } }),
      ).rejects.toMatchObject({ status: 409 });
      expect(resolveEngine).toHaveBeenCalledTimes(3);
      expect(engines).toHaveLength(0);
      requests[0].source.nodes[0].comment = "caller edit";
      gates[1].resolve(config);
      await pending[1];
      await expect(analysis.create(analysisInput("fourth"))).rejects.toMatchObject({ status: 503 });
      gates[2].resolve(config);
      gates[0].resolve(config);
      const jobs = await Promise.all(pending);
      expect(await retry).toBe(jobs[0]);
      expect(jobs[0].source().nodes[0].comment).toBe("");
      expect(resolveEngine).toHaveBeenCalledTimes(3);
      expect(engines).toHaveLength(3);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(3);
    } finally {
      gates.forEach((gate) => gate.resolve(config));
      await Promise.allSettled([...pending, retry]);
    }
  });

  it("waits for every pending analysis request on shutdown without admitting or launching it", async () => {
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<typeof config>());
    gates.forEach((gate) => resolveEngine.mockImplementationOnce(() => gate.promise));
    const pending = ["first", "second", "third"].map((id) => analysis.create(analysisInput(id)));
    const results = Promise.allSettled(pending);
    await vi.advanceTimersByTimeAsync(0);
    const closed = vi.fn();
    const closing = analysis.close().then(closed);
    try {
      await expect(analysis.create(analysisInput("fourth"))).rejects.toMatchObject({ status: 503 });
      gates[0].resolve(config);
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).not.toHaveBeenCalled();
      expect(engines).toHaveLength(0);
    } finally {
      gates.forEach((gate) => gate.resolve(config));
      await closing;
    }
    expect(await results).toEqual(
      Array.from({ length: 3 }, () => ({
        status: "rejected",
        reason: expect.objectContaining({ status: 503 }),
      })),
    );
    expect(analysis.list()).toEqual([]);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("keeps ten completed results and three active jobs readable by the unchanged list decoder", async () => {
    for (let index = 0; index < 10; index++) {
      const session = await games.create(gameInput(`completed-${index}`));
      await vi.advanceTimersByTimeAsync(0);
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(0);
      await closing;
      const job = await analysis.create(analysisInput(`completed-${index}`));
      await vi.advanceTimersByTimeAsync(6000);
      await job.completion;
    }
    await Promise.all(["first", "second", "third"].map((id) => analysis.create(analysisInput(id))));
    await Promise.all(["first", "second", "third"].map((id) => games.create(gameInput(id))));
    expect(analysis.list()).toHaveLength(13);
    expect(decodeJobList(analysis.list()).ok).toBe(true);
    expect(games.list()).toHaveLength(13);
    expect(decodeJobList(games.list()).ok).toBe(true);
  });
});
