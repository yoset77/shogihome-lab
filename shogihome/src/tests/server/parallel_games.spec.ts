// @vitest-environment node
import { Hono } from "hono";
import { Record, RecordMetadataKey, Move } from "tsshogi";
import { GameSessionManager, acquireGameResourceLease } from "@/server/game/manager";
import { GameSession, type GameDependencies } from "@/server/game/session";
import { createGameSessionRoutes } from "@/server/routes/game_sessions";
import { handleError, HttpError } from "@/server/errors";
import { resourceRegistry, ResourceLease } from "@/server/engine/resources";
import { decodeGameRequest, decodeGameSnapshot } from "@/common/game/protocol";
import { decodeJobList } from "@/common/jobs/types";
import { restoreRecord } from "@/common/record/snapshot";
import { MAX_GAME_PARALLELISM } from "@/common/settings/game";
import { t } from "@/common/i18n";
import type { GameEngine } from "@/server/engine/internal";
import { FakeResearchEngine } from "./helpers/analysis";
import { gameRequest, fakeGamePlayer, gameCommand, gameConnection } from "./helpers/game";

vi.mock("@/server/game/limits", () => ({ MAX_GAME_SNAPSHOT_BYTES: 512 * 1024 }));

describe("parallel server games", () => {
  let manager: GameSessionManager;
  const tick = () => vi.advanceTimersByTimeAsync(1);
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    const closing = manager?.close();
    await tick();
    await closing;
    resourceRegistry.resetForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  function setup(deps: GameDependencies = {}, repeat = 5, parallelism = 2, source = new Record()) {
    const players: ReturnType<typeof fakeGamePlayer>[] = [];
    const build = vi.fn(async () => {
      const fake = fakeGamePlayer();
      players.push(fake);
      return fake.player;
    });
    const saved: { id: string; record: Record }[] = [];
    const saveRecord = vi.fn(async (source, _options, id) => {
      saved.push({ id, record: restoreRecord(source).record });
      return `${id}.kifu`;
    });
    const saveBackup = vi.fn(async () => {});
    const addHistory = vi.fn(async () => {});
    manager = new GameSessionManager({
      playerBuilder: { build },
      saveRecord,
      saveBackup,
      addHistory,
      ...deps,
    });
    const request = gameRequest(source);
    request.serverInstanceId = manager.serverInstanceId;
    Object.assign(request.settings, {
      parallelism,
      repeat,
      swapPlayers: true,
      enableAutoSave: true,
      black: { uri: "lan-engine:a", name: "Same" },
      white: { uri: "lan-engine:b", name: "Same" },
    });
    const answered = new Set<unknown>();
    async function resignOne() {
      await tick();
      const search = players.flatMap((p) => p.searches).find((s) => !answered.has(s));
      expect(search).toBeDefined();
      answered.add(search);
      search!.handler.onResign();
      await tick();
    }
    return { request, players, build, saved, saveRecord, saveBackup, addHistory, resignOne };
  }

  it("allocates global game numbers dynamically, reuses players, and aggregates by identity, not name", async () => {
    const gate = Promise.withResolvers<void>();
    const f = setup();
    const save = f.saveRecord.getMockImplementation()!;
    f.saveRecord.mockImplementation(async (...args) => {
      if (args[2].endsWith("_1")) await gate.promise;
      return save(...args);
    });
    const session = await manager.create(f.request);
    try {
      expect(await manager.create(f.request)).toBe(session);
      await expect(
        manager.create({ ...f.request, settings: { ...f.request.settings, parallelism: 3 } }),
      ).rejects.toMatchObject({ status: 409 });
      await tick();
      expect(f.build).toHaveBeenCalledTimes(4);
      expect(manager.list()).toHaveLength(1);
      expect(session.summary()).toMatchObject({ parallelGame: { activeGames: 2, parallelism: 2 } });
      for (let index = 0; index < 5; index++) await f.resignOne();
      expect(f.saved.map((entry) => entry.id.split("_").at(-1))).toEqual(["2", "3", "4", "5"]);
      expect(session.summary()).toMatchObject({ completed: 4, parallelGame: { activeGames: 1 } });
      expect(session.endedAt).toBeUndefined();
      await expect(manager.create({ ...f.request, requestId: "second" })).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      gate.resolve();
      await tick();
      await session.completion;
    }
    expect(session.summary()).toMatchObject({
      state: "completed",
      completed: 5,
      total: 5,
      parallelGame: {
        activeGames: 0,
        results: {
          player1: { name: "Same", win: 2, winBlack: 0, winWhite: 2 },
          player2: { name: "Same", win: 3, winBlack: 0, winWhite: 3 },
          draw: 0,
          invalid: 0,
          total: 5,
        },
      },
    });
    expect(
      f.saved.map((s) => s.record.metadata.getStandardMetadata(RecordMetadataKey.TITLE)).sort(),
    ).toEqual(Array.from({ length: 5 }, (_, i) => `連続対局 ${i + 1}/5`).sort());
    expect(f.addHistory).toHaveBeenCalledTimes(5);
    for (const fake of f.players) expect(fake.player.close).toHaveBeenCalledOnce();
    expect(decodeGameSnapshot(session.publicSnapshot()).ok).toBe(true);
    expect(decodeJobList(manager.list()).ok).toBe(true);
    expect(session.publicSnapshot().record).toEqual(f.request.source);
    await session.close();
    expect(session.summary().state).toBe("completed");
  });

  it("shares one position list and preserves swapped pairs even across different workers", async () => {
    const loadPositions = vi.fn(async () => [
      "position startpos moves 7g7f",
      "position startpos moves 2g2f",
    ]);
    const f = setup({ loadPositions }, 5, 3);
    Object.assign(f.request.settings, {
      startPosition: "list",
      startPositionListFile: "server://positions.sfen",
    });
    const session = await manager.create(f.request);
    for (let index = 0; index < 5; index++) await f.resignOne();
    await session.completion;
    expect(loadPositions).toHaveBeenCalledOnce();
    const firstMoves = f.saved
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => (s.record.moves[1].move as Move).usi);
    expect(firstMoves).toEqual(["7g7f", "7g7f", "2g2f", "2g2f", "7g7f"]);
    // The first turn belongs to White in these positions.
    expect(session.summary().parallelGame?.results).toMatchObject({
      player1: { win: 3, winBlack: 3 },
      player2: { win: 2, winBlack: 2 },
      total: 5,
    });
  });

  it("restores the frozen current position for each game and caps workers at the repeat count", async () => {
    const source = Record.newByUSI("position startpos moves 7g7f") as Record;
    source.current.comment = "Original";
    const acquireResourceLease = vi.fn(async () => undefined);
    const f = setup({ acquireResourceLease }, 2, MAX_GAME_PARALLELISM, source);
    f.request.settings.startPosition = "current";
    const session = await manager.create(f.request);
    await tick();
    expect(acquireResourceLease).toHaveBeenCalledExactlyOnceWith([], 2);
    expect(f.build).toHaveBeenCalledTimes(4);
    await f.resignOne();
    await f.resignOne();
    await session.completion;
    expect(f.saved).toHaveLength(2);
    for (const entry of f.saved) {
      expect(entry.record.moves[1].comment).toBe("Original");
      expect((entry.record.moves[1].move as Move).usi).toBe("7g7f");
    }
  });

  it("cancels every active game, waits for a started save and cleanup, and retains capacity", async () => {
    const saving = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const released = vi.fn();
    const lease = new ResourceLease([], released);
    const f = setup({ acquireResourceLease: async () => lease });
    f.saveRecord.mockImplementationOnce(async (_source, _options, id) => {
      await saving.promise;
      return `${id}.kifu`;
    });
    const session = await manager.create(f.request);
    try {
      await tick();
      f.players[0].player.close = vi.fn(async () => cleanup.promise);
      await f.resignOne();
      expect(f.saveRecord).toHaveBeenCalledOnce();
      session.cancelParallel();
      session.cancelParallel();
      await tick();
      expect(session.summary().state).toBe("cancelling");
      expect(session.endedAt).toBeUndefined();
      expect(f.build).toHaveBeenCalledTimes(4);
      expect(released).not.toHaveBeenCalled();
      saving.resolve();
      await tick();
      expect(f.saveRecord).toHaveBeenCalledTimes(2);
      expect(released).not.toHaveBeenCalled();
      await expect(manager.create({ ...f.request, requestId: "second" })).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      saving.resolve();
      cleanup.resolve();
      await tick();
      await session.completion;
    }
    expect(session.summary()).toMatchObject({
      state: "cancelled",
      completed: 2,
      parallelGame: { results: { invalid: 1 } },
    });
    expect(released).toHaveBeenCalledOnce();
    for (const p of f.players) expect(p.player.close).toHaveBeenCalledOnce();
  });

  it("cancels safely before startup completes without assigning a game", async () => {
    const gate = Promise.withResolvers<string[]>();
    const released = vi.fn();
    const f = setup({
      loadPositions: () => gate.promise,
      acquireResourceLease: async () => new ResourceLease([], released),
    });
    f.request.settings.startPosition = "list";
    f.request.settings.startPositionListFile = "server://positions.sfen";
    const session = await manager.create(f.request);
    await tick();
    session.cancelParallel();
    expect(session.endedAt).toBeUndefined();
    gate.resolve(["position startpos"]);
    await tick();
    await session.completion;
    expect(f.build).not.toHaveBeenCalled();
    expect(session.summary()).toMatchObject({ state: "cancelled", completed: 0 });
    expect(released).toHaveBeenCalledOnce();
  });

  it("stops sibling workers on engine failure and preserves the original error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = setup();
    const session = await manager.create(f.request);
    await tick();
    const search = f.players.flatMap((p) => p.searches)[0];
    search.handler.onError(new Error("Engine failed"));
    await tick();
    await session.completion;
    expect(session.summary()).toMatchObject({
      state: "failed",
      completed: 2,
      parallelGame: { error: "engine", activeGames: 0 },
    });
    expect(f.build).toHaveBeenCalledTimes(4);
    for (const p of f.players) expect(p.player.close).toHaveBeenCalledOnce();
  });

  it("waits for all worker cleanup even when one close fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = setup({}, 2);
    const gate = Promise.withResolvers<void>();
    const session = await manager.create(f.request);
    try {
      await tick();
      vi.mocked(f.players[0].player.close).mockRejectedValue(new Error("close failed"));
      vi.mocked(f.players[1].player.close).mockImplementation(async () => gate.promise);
      session.cancelParallel();
      await tick();
      expect(session.endedAt).toBeUndefined();
    } finally {
      gate.resolve();
      await tick();
      await session.completion;
    }
    expect(session.summary()).toMatchObject({ state: "failed", parallelGame: { error: "engine" } });
  });

  it("continues after save/history failures and uses history backups without auto-save", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = setup({}, 3);
    f.saveRecord.mockRejectedValueOnce(new Error("Disk full"));
    f.addHistory.mockRejectedValueOnce(new Error("History unavailable"));
    const session = await manager.create(f.request);
    for (let i = 0; i < 3; i++) await f.resignOne();
    await session.completion;
    expect(session.summary()).toMatchObject({
      state: "completed",
      completed: 3,
      parallelGame: { error: "save" },
    });
    expect(f.saveBackup).toHaveBeenCalledOnce();
    expect(session.publicSnapshot().records.filter((r) => r.state === "failed")).toHaveLength(2);
    const second = {
      ...f.request,
      requestId: "no-autosave",
      settings: { ...f.request.settings, repeat: 1, enableAutoSave: false },
    };
    const next = await manager.create(second);
    await f.resignOne();
    await next.completion;
    expect(f.saveRecord).toHaveBeenCalledTimes(3);
    expect(f.saveBackup).toHaveBeenCalledTimes(2);
  });

  it("reserves the sum of per-worker engine maxima atomically before launching anything", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 7 }]);
    const configs = [
      { id: "a", name: "A", threads: 4, resource: { groupId: "g" } },
      { id: "b", name: "B", threads: 2, resource: { groupId: "g" } },
    ];
    await expect(acquireGameResourceLease(configs, 2)).rejects.toMatchObject({ status: 503 });
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 8 }] });
    const lease = await acquireGameResourceLease(configs, 2);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    lease!.release();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });
  it("rejects an aggregate reservation at HTTP creation without registering a job or creating engines", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 9 }]);
    const busy = resourceRegistry.acquire({ groupId: "g", cost: 2 });
    const createEngine = vi.fn<() => GameEngine>();
    const resolveEngine = vi.fn(async (id: string) => ({
      id,
      name: id,
      threads: 4,
      resource: { groupId: "g" },
    }));
    const f = setup({
      playerBuilder: undefined,
      createEngine,
      resolveEngine,
      acquireResourceLease: acquireGameResourceLease,
    });
    const app = new Hono().route("/games", createGameSessionRoutes(manager)).onError(handleError);
    const response = await app.request("/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f.request),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(t.resourceGroupCapacity("G", 9, 2, 8));
    expect(manager.list()).toEqual([]);
    expect(() => manager.byRequest(f.request.requestId)).toThrow(
      expect.objectContaining({ status: 410 }),
    );
    expect(createEngine).not.toHaveBeenCalled();
    expect(resolveEngine.mock.calls).toEqual([["a"], ["b"]]);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(2);
    busy!.release();
  });

  it("allows the same rejected request to retry with a lower parallelism", async () => {
    const released = vi.fn();
    const message = t.resourceGroupCapacity("CPU", 8, 0, 12);
    const acquireResourceLease = vi
      .fn<NonNullable<GameDependencies["acquireResourceLease"]>>()
      .mockRejectedValueOnce(new HttpError(503, message))
      .mockResolvedValueOnce(new ResourceLease([], released));
    const f = setup({ acquireResourceLease }, 5, 3);
    await expect(manager.create(f.request)).rejects.toMatchObject({ status: 503, message });
    expect(manager.list()).toEqual([]);
    expect(f.build).not.toHaveBeenCalled();
    f.request.settings.parallelism = 2;
    const session = await manager.create(f.request);
    expect(acquireResourceLease.mock.calls.map((call) => call[1])).toEqual([3, 2]);
    session.cancelParallel();
    await tick();
    await session.completion;
    expect(released).toHaveBeenCalledOnce();
  });

  it("deduplicates in-flight creation and rejects conflicting or competing starts", async () => {
    const gate = Promise.withResolvers<ResourceLease | undefined>();
    const released = vi.fn();
    const acquireResourceLease = vi.fn(() => gate.promise);
    const f = setup({ acquireResourceLease });
    const original = structuredClone(f.request);
    const creating = manager.create(f.request);
    const retry = manager.create(f.request);
    await expect(
      manager.create({ ...f.request, settings: { ...f.request.settings, parallelism: 3 } }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(manager.create({ ...f.request, requestId: "other" })).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      manager.create({
        ...f.request,
        requestId: "serial",
        settings: { ...f.request.settings, parallelism: 1 },
      }),
    ).rejects.toMatchObject({ status: 503 });
    f.request.settings.parallelism = 3;
    expect(manager.list()).toEqual([]);
    expect(f.build).not.toHaveBeenCalled();
    gate.resolve(new ResourceLease([], released));
    const session = await creating;
    expect(await retry).toBe(session);
    expect(await manager.create(original)).toBe(session);
    expect(session.request.settings.parallelism).toBe(2);
    expect(acquireResourceLease).toHaveBeenCalledExactlyOnceWith([], 2);
    expect(manager.list()).toHaveLength(1);
    session.cancelParallel();
    await tick();
    await session.completion;
    expect(released).toHaveBeenCalledOnce();
  });

  it("releases an acquired lease if the manager closes before admission completes", async () => {
    const gate = Promise.withResolvers<ResourceLease | undefined>();
    const released = vi.fn();
    const acquireResourceLease = vi.fn(() => gate.promise);
    const f = setup({ acquireResourceLease });
    const creating = manager.create(f.request);
    const rejected = expect(creating).rejects.toMatchObject({ status: 503 });
    await tick();
    expect(acquireResourceLease).toHaveBeenCalledOnce();
    const closing = manager.close();
    gate.resolve(new ResourceLease([], released));
    await rejected;
    await closing;
    expect(manager.list()).toEqual([]);
    expect(f.build).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
  });

  it("does not reserve resources if the manager closes during engine resolution", async () => {
    const gate = Promise.withResolvers<{ id: string; name: string }>();
    const acquireResourceLease = vi.fn(async () => undefined);
    const createEngine = vi.fn<() => GameEngine>();
    const f = setup({
      playerBuilder: undefined,
      resolveEngine: () => gate.promise,
      acquireResourceLease,
      createEngine,
    });
    f.request.settings.white = { ...f.request.settings.black };
    const creating = manager.create(f.request);
    const rejected = expect(creating).rejects.toMatchObject({ status: 503 });
    const closing = manager.close();
    gate.resolve({ id: "a", name: "A" });
    await rejected;
    await closing;
    expect(manager.list()).toEqual([]);
    expect(acquireResourceLease).not.toHaveBeenCalled();
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("releases a pre-acquired lease if session initialization fails", async () => {
    const released = vi.fn();
    const f = setup({ acquireResourceLease: async () => new ResourceLease([], released) });
    vi.spyOn(GameSession.prototype, "start").mockImplementationOnce(() => {
      throw new Error("Initialization failed");
    });
    await expect(manager.create(f.request)).rejects.toThrow("Initialization failed");
    expect(manager.list()).toEqual([]);
    expect(f.build).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "cleans every partially launched worker on startup cancellation/failure (%s)",
    async (fail) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
      const engines: (FakeResearchEngine & GameEngine)[] = [];
      const startup = Promise.withResolvers<void>();
      const config = { id: "a", name: "A", threads: 4, resource: { groupId: "g" } };
      const resolveEngine = vi.fn(async (id: string) => ({ ...config, id }));
      const createEngine = vi.fn(() => {
        const engine = Object.assign(new FakeResearchEngine(), {
          cancelAll: vi.fn(async () => {}),
          gameover: vi.fn(),
          startSearch: vi.fn<GameEngine["startSearch"]>(async () => ({
            finished: new Promise<void>(() => {}),
            stop: async () => {},
            cancel: async () => {},
          })),
        });
        if (engines.length === 0)
          engine.launch.mockImplementation(async (_config, _timeout, signal) => {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
              void startup.promise.then(resolve);
            });
            if (signal.aborted || fail) throw new Error("Startup failed");
          });
        engines.push(engine);
        return engine;
      });
      const f = setup({
        playerBuilder: undefined,
        createEngine,
        resolveEngine,
        acquireResourceLease: acquireGameResourceLease,
      });
      const session = await manager.create(f.request);
      await tick();
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
      expect(resolveEngine).toHaveBeenCalledTimes(2);
      config.threads = 50;
      if (fail) startup.resolve();
      else session.cancelParallel();
      await tick();
      await session.completion;
      expect(session.summary().state).toBe(fail ? "failed" : "cancelled");
      for (const engine of engines) {
        expect(engine.launch.mock.calls[0][0].threads).toBe(4);
        expect(engine.close).toHaveBeenCalledOnce();
      }
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    },
  );

  it("enforces background-only control at HTTP and WebSocket boundaries and provides idempotent stop", async () => {
    const f = setup();
    const app = new Hono().route("/games", createGameSessionRoutes(manager)).onError(handleError);
    const post = (path: string, body?: unknown) =>
      app.request(path, {
        method: "POST",
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
    const created = await post("/games", f.request);
    expect(created.status).toBe(202);
    const status = await created.json();
    const session = manager.get(status.sessionId);
    await tick();
    expect(status.controllerOwnerId).toBeUndefined();
    expect(status.controllerRecoveryId).toBeUndefined();
    const attach = { ownerId: "controller", epoch: 0, takeover: false, screenId: "screen" };
    for (const route of ["attach", "attached-snapshot"])
      expect((await post(`/games/${session.id}/${route}`, attach)).status).toBe(409);
    expect(
      (await post(`/games/${session.id}/commands`, gameCommand(session.snapshot(), "interrupt")))
        .status,
    ).toBe(409);
    expect(() =>
      session.connect(
        "controller",
        () => {},
        () => {},
        gameConnection(session.snapshot()),
      ),
    ).toThrow();
    expect(session.attachment().attached).toBe(false);
    expect((await post(`/games/${session.id}/cancel`)).status).toBe(202);
    expect((await post(`/games/${session.id}/cancel`)).status).toBe(202);
    await tick();
    await session.completion;
    expect((await post(`/games/${session.id}/attach`, attach)).status).toBe(409);
    const response = await app.request(`/games/by-request/${f.request.requestId}`);
    expect(decodeGameSnapshot(await response.json()).ok).toBe(true);
  });

  it.each([null, 0, -1, 1.5, "2", MAX_GAME_PARALLELISM + 1])(
    "rejects invalid parallelism %s",
    (parallelism) => {
      const f = setup();
      expect(
        decodeGameRequest({ ...f.request, settings: { ...f.request.settings, parallelism } }).ok,
      ).toBe(false);
    },
  );
  it("rejects human participation and defaults legacy requests to serial execution", async () => {
    const f = setup();
    const request = gameRequest();
    expect(decodeGameRequest(request)).toMatchObject({
      ok: true,
      value: { settings: { parallelism: 1 } },
    });
    request.settings.parallelism = 2;
    expect(decodeGameRequest(request).ok).toBe(false);
    await expect(
      manager.create({ ...f.request, settings: request.settings }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("applies the existing record-size guard to every worker before starting a search", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = Record.newByUSI(
      "position startpos moves 7g7f 3c3d 2g2f 8c8d 2f2e 8d8e",
    ) as Record;
    for (const node of source.moves) node.comment = "x".repeat(50_000);
    const f = setup({}, 5, 2, source);
    f.request.settings.startPosition = "current";
    const session = await manager.create(f.request);
    await tick();
    await session.completion;
    expect(session.summary()).toMatchObject({
      state: "failed",
      parallelGame: { error: "capacity" },
    });
    expect(f.players.flatMap((p) => p.searches)).toHaveLength(0);
    for (const p of f.players) expect(p.player.close).toHaveBeenCalledOnce();
  });
});
