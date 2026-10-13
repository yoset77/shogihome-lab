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

const engine = (overrides: Partial<EngineConfig> = {}): EngineConfig => ({
  id: "engine-1",
  name: "Engine 1",
  ...overrides,
});

afterEach(() => resourceRegistry.resetForTest());

describe("engine resource cost", () => {
  it("uses the Threads option in automatic mode and falls back to 1", () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    expect(engineResourceCost(engine({ threads: 4, resource: { groupId: "g" } }))).toBe(4);
    // Unresolvable Threads falls back to 1 instead of bypassing the budget.
    expect(engineResourceCost(engine({ resource: { groupId: "g" } }))).toBe(1);
    expect(engineResourceCost(engine({ threads: 0, resource: { groupId: "g" } }))).toBe(1);
  });

  it("uses the manual cost in manual mode", () => {
    expect(
      engineResourceCost(
        engine({ threads: 2, resource: { groupId: "g", autoThreads: false, cost: 6 } }),
      ),
    ).toBe(6);
  });

  it("treats engines without a resource assignment as unmanaged", () => {
    expect(engineResourceCost(engine({ threads: 4 }))).toBe(0);
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

  it("returns no requirements while the budget is disabled", () => {
    resourceRegistry.resetForTest(false, [{ id: "g", name: "G", budget: 8 }]);
    expect(engineRequirements(engine({ threads: 4, resource: { groupId: "g" } }))).toEqual([]);
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
    resourceRegistry.acquire(
      ...engineRequirements(engine({ threads: 4, resource: { groupId: "g" } })),
    );
    // Refresh with the same group: usage is carried over.
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 16 }] });
    expect(resourceRegistry.groupSnapshot()).toEqual([{ id: "g", name: "G", budget: 16, used: 4 }]);
    // Refresh without the group: the reservation loses its accounting.
    resourceRegistry.update({ enabled: true, groups: [] });
    expect(resourceRegistry.isEnabled()).toBe(false);
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 8 }] });
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
        throw new HttpError(503, "over budget");
      },
    });
    session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.snapshot().state).toBe("failed");
    expect(session.snapshot().error).toBe("capacity");
    await session.close();
  });
});
