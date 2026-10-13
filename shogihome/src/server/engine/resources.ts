import { isValidResourceBudget } from "@/common/engine/relay_protocol";
import { t } from "@/common/i18n";
import { HttpError } from "@/server/errors";
import type { EngineConfig } from "./types";

// Resource budget management. The goal is to prevent accidental self-DoS
// (too many concurrent engines) by estimating costs from the configured
// Threads option, not to measure or enforce real CPU usage. Reservations
// are best-effort: the acquiring owner releases the lease when its engine
// work is done, and a transient overcount during forced cleanup is
// acceptable.

export type ResourceRequirement = {
  groupId: string;
  cost: number;
};

export class ResourceLease {
  private released = false;
  constructor(
    private readonly amounts: { group: { used: number }; cost: number }[],
    private readonly onRelease?: () => void,
  ) {}
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const amount of this.amounts) {
      amount.group.used -= amount.cost;
    }
    this.onRelease?.();
  }
}

export type ResourceGroupSnapshot = { id: string; name: string; budget: number; used: number };

class ResourceRegistry {
  private enabled = false;
  private groups = new Map<
    string,
    { name: string; budget: number; used: number; configured: boolean }
  >();

  private pruneRetiredGroups(): void {
    for (const [id, group] of this.groups) {
      if (!group.configured && group.used === 0) this.groups.delete(id);
    }
  }

  /** Replace the configuration from the latest engines.json document. */
  update(
    settings:
      { enabled?: boolean; groups?: { id: string; name: string; budget: number }[] } | undefined,
  ): void {
    // Existing groups are updated in place so leases keep referencing the
    // live accounting object across list refetches. Group ids must be
    // unique (validated by the shared codec), so a duplicate id cannot
    // double-count here.
    const seen = new Set<string>();
    for (const group of settings?.groups ?? []) {
      seen.add(group.id);
      const existing = this.groups.get(group.id);
      if (existing) {
        existing.name = group.name;
        existing.budget = group.budget;
        existing.configured = true;
      } else {
        this.groups.set(group.id, {
          name: group.name,
          budget: group.budget,
          used: 0,
          configured: true,
        });
      }
    }
    for (const [id, group] of this.groups) {
      if (!seen.has(id)) group.configured = false;
    }
    // Deleted groups retain their accounting until their final lease ends.
    this.pruneRetiredGroups();
    this.enabled = !!settings?.enabled && seen.size > 0;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  groupSnapshot(): ResourceGroupSnapshot[] {
    return [...this.groups.entries()]
      .filter(([, group]) => group.configured)
      .map(([id, group]) => ({
        id,
        name: group.name,
        budget: group.budget,
        used: group.used,
      }));
  }

  /** CPU cost estimate for one engine. Unmanaged engines consume nothing. */
  requirement(engine: EngineConfig): ResourceRequirement | undefined {
    const groupId = engine.resource?.groupId;
    if (!groupId) return undefined;
    const group = this.groups.get(groupId);
    if (!group) {
      // Unknown group: the engine stays unmanaged rather than being
      // rejected, matching the "no group = no budget" rule.
      console.warn(
        `Engine "${engine.id}" references unknown resource group "${groupId}"; it is not counted`,
      );
      return undefined;
    }
    const cost = engineResourceCost(engine);
    if (cost <= 0) return undefined;
    return { groupId, cost };
  }

  /**
   * Atomically reserve the requirements. Throws `HttpError` (503) with a
   * user-visible message when any group would exceed its budget. Returns
   * `undefined` when nothing has to be reserved.
   */
  acquire(...requirements: (ResourceRequirement | undefined)[]): ResourceLease | undefined {
    const active = requirements.filter(
      (item): item is ResourceRequirement => !!item && item.cost > 0,
    );
    if (active.length === 0) return undefined;
    // Sum duplicates first so one owner cannot pass two half-cost entries.
    const merged = new Map<string, number>();
    for (const item of active) {
      merged.set(item.groupId, (merged.get(item.groupId) ?? 0) + item.cost);
    }
    for (const [groupId, cost] of merged) {
      const group = this.groups.get(groupId);
      if (!group) continue; // unmanaged: never blocks acquisition
      const used = group.used + cost;
      // Keep release arithmetic exact even while budget enforcement is disabled.
      if (
        !Number.isSafeInteger(cost) ||
        !Number.isSafeInteger(used) ||
        (this.enabled && group.configured && used > group.budget)
      ) {
        throw new HttpError(
          503,
          t.resourceGroupCapacity(group.name, group.budget, group.used, cost),
        );
      }
    }
    const amounts: { group: { used: number }; cost: number }[] = [];
    for (const [groupId, cost] of merged) {
      const group = this.groups.get(groupId);
      if (!group) continue;
      amounts.push({ group, cost });
    }
    for (const amount of amounts) {
      amount.group.used += amount.cost;
    }
    if (amounts.length === 0) return undefined;
    // Disabled enforcement still records usage for later re-enablement.
    return new ResourceLease(amounts, () => this.pruneRetiredGroups());
  }

  resetForTest(enabled = false, groups: { id: string; name: string; budget: number }[] = []): void {
    this.groups.clear();
    this.update({ enabled, groups });
  }
}

export const resourceRegistry = new ResourceRegistry();

/**
 * Cost of one engine in thread units. `autoThreads` (the default when the
 * resource config exists) follows the configured `Threads` option; an
 * unresolvable value requires an explicit manual cost. Manual mode uses the
 * configured cost. Threads=0 means an automatic setting and is not a valid
 * cost either.
 */
export function engineResourceCost(engine: EngineConfig): number {
  const resource = engine.resource;
  if (!resource?.groupId) return 0;
  if (resource.autoThreads === false) {
    const cost = resource.cost;
    if (!isValidResourceBudget(cost)) {
      throw new HttpError(400, t.resourceManualCostRequired(engine.name));
    }
    return cost;
  }
  const threads = engine.threads;
  if (!isValidResourceBudget(threads)) {
    throw new HttpError(400, t.resourceThreadsUnavailable(engine.name));
  }
  return threads;
}

/** Per-group cost entries for one engine, including while enforcement is disabled. */
export function engineRequirements(engine: EngineConfig): ResourceRequirement[] {
  const requirement = resourceRegistry.requirement(engine);
  return requirement ? [requirement] : [];
}

/**
 * AI-vs-AI games search alternately without ponder, so the game reserves
 * the larger of the two engines per group and keeps it for the whole
 * session. Note that a future memory/VRAM budget must sum both engines
 * instead.
 */
export function maxRequirements(...lists: ResourceRequirement[][]): ResourceRequirement[] {
  const result = new Map<string, number>();
  for (const list of lists) {
    for (const item of list) {
      result.set(item.groupId, Math.max(result.get(item.groupId) ?? 0, item.cost));
    }
  }
  return [...result].map(([groupId, cost]) => ({ groupId, cost }));
}
