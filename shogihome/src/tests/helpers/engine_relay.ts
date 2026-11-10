import type { SearchSnapshot } from "@/common/engine/relay_protocol";

export function searchSnapshot(overrides: Partial<SearchSnapshot> = {}): SearchSnapshot {
  return {
    type: "searchSnapshot",
    instanceId: "test-instance",
    revision: 1,
    engineId: "test-engine",
    accepted: 0,
    cancelled: 0,
    settled: 0,
    active: null,
    protectionMs: 60000,
    terminal: null,
    ...overrides,
  };
}
