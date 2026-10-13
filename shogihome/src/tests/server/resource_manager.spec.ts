import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "@/server/errors";
import {
  engineRequirements,
  engineResourceCost,
  maxRequirements,
  resourceRegistry,
  type ResourceLease,
} from "@/server/engine/resources";
import type { EngineConfig } from "@/server/engine/types";
import { AnalysisJobManager } from "@/server/analysis/jobManager";
import { FakeResearchEngine, requestFor } from "./helpers/analysis";
import { fakeGamePlayer, gameRequest } from "./helpers/game";
import { GameSession } from "@/server/game/session";
import { acquireGameResourceLease } from "@/server/game/manager";
import * as engineList from "@/server/engine/list";
import type { GameEngine } from "@/server/engine/internal";
import { decodeGameSnapshot } from "@/common/game/protocol";
import { t } from "@/common/i18n";

vi.mock("@/server/file/history", () => ({
  addHistory: vi.fn(async () => {}),
  saveBackup: vi.fn(async () => {}),
}));

const engine = (overrides: Partial<EngineConfig> = {}): EngineConfig => ({
  id: "engine-1",
  name: "Engine 1",
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
  resourceRegistry.resetForTest();
});

describe("engine resource cost", () => {
  it("uses the Threads option in automatic mode", () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    expect(engineResourceCost(engine({ threads: 4, resource: { groupId: "g" } }))).toBe(4);
  });

  it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "requires a manual cost for unresolvable Threads %s",
    (threads) => {
      const config = engine({ threads, resource: { groupId: "g" } });
      expect(() => engineResourceCost(config)).toThrow(HttpError);
      expect(() => engineResourceCost(config)).toThrow(/Engine 1.*Threads/);
    },
  );

  it("uses the manual cost in manual mode", () => {
    expect(
      engineResourceCost(
        engine({ threads: 2, resource: { groupId: "g", autoThreads: false, cost: 6 } }),
      ),
    ).toBe(6);
    expect(
      engineResourceCost(engine({ resource: { groupId: "g", autoThreads: false, cost: 3 } })),
    ).toBe(3);
  });

  it("requires a valid manual cost rather than silently substituting 1", () => {
    for (const cost of [undefined, 0, -1, 1.5, NaN, Infinity]) {
      expect(() =>
        engineResourceCost(engine({ resource: { groupId: "g", autoThreads: false, cost } })),
      ).toThrow(HttpError);
    }
  });

  it("treats engines without a resource assignment as unmanaged", () => {
    expect(engineResourceCost(engine({ threads: 4 }))).toBe(0);
    expect(engineResourceCost(engine({ resource: {} }))).toBe(0);
    expect(engineResourceCost(engine({ resource: { groupId: "" } }))).toBe(0);
  });

  it("skips unmanaged engines in requirements", () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    expect(engineRequirements(engine({ threads: 4 }))).toEqual([]);
    expect(engineRequirements(engine({ threads: 4, resource: { groupId: "missing" } }))).toEqual(
      [],
    );
    expect(engineRequirements(engine({ threads: 4, resource: { groupId: "g" } }))).toEqual([
      { groupId: "g", cost: 4 },
    ]);
  });

  it("keeps accounting requirements while enforcement is disabled", () => {
    resourceRegistry.resetForTest(false, [{ id: "g", name: "G", budget: 8 }]);
    expect(engineRequirements(engine({ threads: 4, resource: { groupId: "g" } }))).toEqual([
      { groupId: "g", cost: 4 },
    ]);
    expect(() => engineRequirements(engine({ resource: { groupId: "g" } }))).toThrow(HttpError);
  });
});

describe("resource reservation", () => {
  it("reserves and releases the budget idempotently", () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    const lease = resourceRegistry.acquire(
      ...engineRequirements(engine({ threads: 4, resource: { groupId: "g" } })),
    );
    expect(resourceRegistry.groupSnapshot()).toEqual([{ id: "g", name: "G", budget: 8, used: 4 }]);
    lease!.release();
    lease!.release();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("accepts a request matching the remaining budget exactly and rejects beyond it", () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    const lease = resourceRegistry.acquire(
      ...engineRequirements(engine({ threads: 4, resource: { groupId: "g" } })),
    );
    const second = resourceRegistry.acquire(
      ...engineRequirements(engine({ threads: 4, resource: { groupId: "g" } })),
    );
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    expect(() =>
      resourceRegistry.acquire(
        ...engineRequirements(engine({ threads: 1, resource: { groupId: "g" } })),
      ),
    ).toThrow(HttpError);
    lease!.release();
    second!.release();
    // The budget is available again after release.
    expect(
      resourceRegistry.acquire(
        ...engineRequirements(engine({ threads: 8, resource: { groupId: "g" } })),
      ),
    ).toBeDefined();
  });

  it("does not reserve unmanaged or unknown groups even while enabled", () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 1 }]);
    expect(
      resourceRegistry.acquire(...engineRequirements(engine({ resource: { groupId: "x" } }))),
    ).toBeUndefined();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("keeps reservations across list refetches and restores them on release", () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    const lease = resourceRegistry.acquire(
      ...engineRequirements(engine({ threads: 4, resource: { groupId: "g" } })),
    );
    // Refresh with the same group: usage is carried over.
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 16 }] });
    expect(resourceRegistry.groupSnapshot()).toEqual([{ id: "g", name: "G", budget: 16, used: 4 }]);
    // Removing and restoring a group must not lose its active leases.
    resourceRegistry.update({ enabled: true, groups: [] });
    expect(resourceRegistry.isEnabled()).toBe(false);
    expect(resourceRegistry.groupSnapshot()).toEqual([]);
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 8 }] });
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    lease!.release();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("rejects additional work after enabling budgets with engines started while disabled", () => {
    const groups = [{ id: "g", name: "G", budget: 4 }];
    resourceRegistry.resetForTest(false, groups);
    const requirement = engineRequirements(engine({ threads: 8, resource: { groupId: "g" } }));
    const lease = resourceRegistry.acquire(...requirement);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    resourceRegistry.update({ enabled: true, groups });
    expect(() => resourceRegistry.acquire({ groupId: "g", cost: 1 })).toThrow(HttpError);
    lease!.release();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("keeps a full reservation when its group is removed and restored", () => {
    const groups = [{ id: "g", name: "G", budget: 8 }];
    resourceRegistry.resetForTest(true, groups);
    const lease = resourceRegistry.acquire({ groupId: "g", cost: 8 });
    resourceRegistry.update(undefined);
    resourceRegistry.update({ enabled: true, groups });
    expect(() => resourceRegistry.acquire({ groupId: "g", cost: 1 })).toThrow(HttpError);
    lease!.release();
    lease!.release();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("releases deleted groups before reusing their ids without corrupting later leases", () => {
    const groups = [{ id: "g", name: "G", budget: 8 }];
    resourceRegistry.resetForTest(true, groups);
    const old = resourceRegistry.acquire({ groupId: "g", cost: 8 });
    resourceRegistry.update(undefined);
    old!.release();
    resourceRegistry.update({ enabled: true, groups });
    const current = resourceRegistry.acquire({ groupId: "g", cost: 8 });
    old!.release();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    current!.release();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("merges the per-group maximum for AI-vs-AI games", () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 12 }]);
    const black = engine({ threads: 12, resource: { groupId: "g" } });
    const white = engine({ threads: 8, resource: { groupId: "g" } });
    const lease = resourceRegistry.acquire(
      ...maxRequirements(engineRequirements(black), engineRequirements(white)),
    );
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(12);
    lease!.release();
  });

  it("merges budgets across different groups", () => {
    resourceRegistry.resetForTest(true, [
      { id: "local", name: "Local", budget: 4 },
      { id: "remote", name: "Remote", budget: 4 },
    ]);
    const black = engine({ threads: 4, resource: { groupId: "local" } });
    const white = engine({ threads: 3, resource: { groupId: "remote" } });
    const lease = resourceRegistry.acquire(
      ...maxRequirements(engineRequirements(black), engineRequirements(white)),
    );
    expect(resourceRegistry.groupSnapshot().map((group) => group.used)).toEqual([4, 3]);
    lease!.release();
    expect(resourceRegistry.groupSnapshot().map((group) => group.used)).toEqual([0, 0]);
  });
});

describe("owner integration", () => {
  const managedEngine = async () => ({
    id: "test",
    name: "my usi engine",
    threads: 8,
    resource: { groupId: "g" },
  });

  it("launches analysis with the same configuration snapshot used for its reservation", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    const original = { ...(await managedEngine()), threads: 4 };
    const resolver = vi
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, threads: 12 });
    const research = new FakeResearchEngine();
    const manager = new AnalysisJobManager(() => research, resolver);
    const request = { ...requestFor(), serverInstanceId: manager.serverInstanceId };
    try {
      await manager.create(request);
      await vi.waitFor(() => expect(research.launch).toHaveBeenCalled());
      expect(resolver).toHaveBeenCalledOnce();
      expect(research.launch.mock.calls[0][0]).toMatchObject({ threads: 4 });
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    } finally {
      await manager.close();
    }
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("uses one game registry snapshot for both reservation and player launch", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    const original = { ...(await managedEngine()), threads: 4, type: ["game"] };
    const white = { ...original, id: "white", threads: 6 };
    const fetch = vi
      .spyOn(engineList, "fetchEngineConfigs")
      .mockResolvedValueOnce([original, white])
      .mockResolvedValue([
        { ...original, threads: 12 },
        { ...white, threads: 12 },
      ]);
    const gameEngine: GameEngine = {
      launch: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      setMultiPV: vi.fn(),
      readyNewGame: vi.fn(),
      startResearch: vi.fn(),
      startSearch: vi.fn(async () => ({
        finished: new Promise<void>(() => {}),
        stop: async () => {},
        cancel: async () => {},
      })),
      cancelAll: vi.fn(async () => {}),
      gameover: vi.fn(),
    };
    const request = gameRequest();
    request.settings.black = { uri: "lan-engine:test", name: "AI" };
    request.settings.white = { uri: "lan-engine:white", name: "White AI" };
    const session = new GameSession("snapshot", request, {
      createEngine: () => gameEngine,
      acquireResourceLease: acquireGameResourceLease,
    });
    session.start();
    try {
      await vi.waitFor(() => expect(gameEngine.launch).toHaveBeenCalledTimes(2));
      expect(fetch).toHaveBeenCalledOnce();
      expect(vi.mocked(gameEngine.launch).mock.calls[0][0]).toMatchObject({ threads: 4 });
      expect(vi.mocked(gameEngine.launch).mock.calls[1][0]).toMatchObject({ threads: 6 });
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(6);
    } finally {
      await session.close();
    }
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("does not retry a failed analysis resolution and launch without a reservation", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 4 }]);
    const resolver = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValue(await managedEngine());
    const research = new FakeResearchEngine();
    const manager = new AnalysisJobManager(() => research, resolver);
    try {
      const job = await manager.create({
        ...requestFor(),
        serverInstanceId: manager.serverInstanceId,
      });
      await job.completion;
      expect(job.status()).toMatchObject({ state: "failed", error: "engine" });
      expect(resolver).toHaveBeenCalledOnce();
      expect(research.launch).not.toHaveBeenCalled();
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    } finally {
      await manager.close();
    }
  });

  it("rejects analysis job creation at the HTTP boundary and frees the slot", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 4 }]);
    let manager = new AnalysisJobManager(() => new FakeResearchEngine(), managedEngine);
    const request = requestFor();
    request.serverInstanceId = manager.serverInstanceId;
    await expect(manager.create(request)).rejects.toThrow(HttpError);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    // A smaller budget reservation starts a job and is released at the end.
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    manager = new AnalysisJobManager(() => new FakeResearchEngine(), managedEngine);
    const job = await manager.create({ ...request, serverInstanceId: manager.serverInstanceId });
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(8);
    await job.cancel();
    await job.completion;
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("shares one game reservation and frees it only when the session ends", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 12 }]);
    const fake = fakeGamePlayer();
    const leases: ResourceLease[] = [];
    const request = gameRequest();
    request.serverInstanceId = "server";
    request.settings.black = { uri: "lan-engine:black", name: "B" };
    request.settings.white = { uri: "lan-engine:white", name: "W" };
    const session = new GameSession("session", request, {
      playerBuilder: fake.builder,
      acquireResourceLease: async () => {
        // Emulates acquireGameResourceLease: per-group maximum over both engines.
        const lease = resourceRegistry.acquire(
          ...maxRequirements(
            engineRequirements(engine({ threads: 12, resource: { groupId: "g" } })),
            engineRequirements(engine({ threads: 8, resource: { groupId: "g" } })),
          ),
        );
        if (lease) leases.push(lease);
        return lease;
      },
    });
    session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(12);
    // A second game for the same engine must be rejected.
    expect(() =>
      resourceRegistry.acquire(
        ...engineRequirements(engine({ threads: 1, resource: { groupId: "g" } })),
      ),
    ).toThrow(HttpError);
    await session.close();
    leases.forEach((lease) => lease.release());
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("marks a rejected game startup as a capacity error without a dangling lease", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 4 }]);
    const fake = fakeGamePlayer();
    const request = gameRequest();
    request.settings.black = { uri: "lan-engine:black", name: "B" };
    const session = new GameSession("session", request, {
      playerBuilder: fake.builder,
      acquireResourceLease: async () => {
        throw new HttpError(503, t.resourceGroupCapacity("CPU", 4, 3, 8));
      },
    });
    session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.snapshot().state).toBe("failed");
    expect(session.snapshot().error).toBe("capacity");
    const decoded = decodeGameSnapshot(session.snapshot());
    expect(decoded.ok && decoded.value).toMatchObject({
      errorMessage: t.resourceGroupCapacity("CPU", 4, 3, 8),
    });
    for (const errorMessage of [42, "x".repeat(2049)]) {
      expect(decodeGameSnapshot({ ...session.snapshot(), errorMessage }).ok).toBe(false);
    }
    await session.close();
  });
});
