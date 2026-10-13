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
  constructor(private readonly amounts: { group: { used: number }; cost: number }[]) {}
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const amount of this.amounts) {
      // Decrement the captured accounting object. A configuration update
      // replaces the map, so a stale lease cannot corrupt the new state.
      amount.group.used -= amount.cost;
    }
  }
}

export type ResourceGroupSnapshot = { id: string; name: string; budget: number; used: number };

class ResourceRegistry {
  private enabled = false;
  private groups = new Map<string, { name: string; budget: number; used: number }>();

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
      } else {
        this.groups.set(group.id, { name: group.name, budget: group.budget, used: 0 });
      }
    }
    for (const id of [...this.groups.keys()]) {
      if (!seen.has(id)) this.groups.delete(id);
    }
    this.enabled = !!settings?.enabled && this.groups.size > 0;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  groupSnapshot(): ResourceGroupSnapshot[] {
    return [...this.groups.entries()].map(([id, group]) => ({
      id,
      name: group.name,
      budget: group.budget,
      used: group.used,
    }));
  }

  /** CPU cost estimate for one engine. Unmanaged engines consume nothing. */
  requirement(engine: EngineConfig): ResourceRequirement | undefined {
    if (!this.enabled) return undefined;
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
    if (!this.enabled || active.length === 0) return undefined; // Sum duplicates first so one owner cannot pass two half-cost entries.
    const merged = new Map<string, number>();
    for (const item of active) {
      merged.set(item.groupId, (merged.get(item.groupId) ?? 0) + item.cost);
    }
    for (const [groupId, cost] of merged) {
      const group = this.groups.get(groupId);
      if (!group) continue; // unmanaged: never blocks acquisition
      const used = group.used + cost;
      if (used > group.budget) {
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
    return new ResourceLease(amounts);
  }

  resetForTest(enabled = false, groups: { id: string; name: string; budget: number }[] = []): void {
    this.update({ enabled, groups });
    for (const group of this.groups.values()) group.used = 0;
  }
}

export const resourceRegistry = new ResourceRegistry();

/**
 * Cost of one engine in thread units. `autoThreads` (the default when the
 * resource config exists) follows the configured `Threads` option; an
 * unresolvable value falls back to 1 with a warning. Manual mode uses the
 * configured cost. Threads=0 means an automatic setting and is not a valid
 * cost either.
 */
export function engineResourceCost(engine: EngineConfig): number {
  const resource = engine.resource;
  if (!resource) return 0;
  if (resource.autoThreads === false) return Math.max(1, resource.cost ?? 1);
  const threads = engine.threads;
  if (threads === undefined || threads <= 0) {
    console.warn(
      `Engine "${engine.id}" has no resolvable Threads option; assuming a cost of 1. Set a manual cost in the config editor.`,
    );
    return 1;
  }
  return threads;
}

/** Per-group cost entries for one engine. Empty when unmanaged or disabled. */
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
