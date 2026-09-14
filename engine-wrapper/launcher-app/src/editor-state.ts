// Pure config-editor state logic (no DOM). Unit-tested with vitest.
import type { EngineEntry } from "./api";

export const ENGINE_TYPES = ["game", "research", "mate"] as const;

const ULID_ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateId(randomBytes?: (n: number) => number[]): string {
  let time = Date.now();
  let out = "";
  for (let i = 0; i < 10; i++) {
    const mod = time % 32;
    out = ULID_ENCODING.charAt(mod) + out;
    time = (time - mod) / 32;
  }
  const rand = randomBytes ? randomBytes(16) : Array.from(crypto.getRandomValues(new Uint8Array(16)));
  for (let i = 0; i < 16; i++) out += ULID_ENCODING.charAt(rand[i] % 32);
  return out;
}

/** Normalize legacy `type` forms to a sorted, deduplicated list. */
export function normalizeType(input: unknown): string[] {
  const list = Array.isArray(input) ? input : input === "both" || input === undefined ? ["game", "research", "mate"] : [input];
  const filtered = [...new Set(list.filter((t): t is string => typeof t === "string" && (ENGINE_TYPES as readonly string[]).includes(t)))];
  filtered.sort();
  return filtered;
}

export interface Group {
  id: string;
  name: string;
}

export function uniqueGroups(engines: EngineEntry[], virtual: Group[]): Group[] {
  const groups = new Map<string, string>();
  for (const eng of engines) {
    if (eng.analysisDBGroupId && eng.analysisDBGroupName) groups.set(eng.analysisDBGroupId, eng.analysisDBGroupName);
  }
  for (const g of virtual) groups.set(g.id, g.name);
  return [...groups.entries()].map(([id, name]) => ({ id, name }));
}

export function renameGroup(engines: EngineEntry[], virtual: Group[], groupId: string, name: string): void {
  for (const eng of engines) if (eng.analysisDBGroupId === groupId) eng.analysisDBGroupName = name;
  for (const g of virtual) if (g.id === groupId) g.name = name;
}

export function deleteGroup(engines: EngineEntry[], virtual: Group[], groupId: string): Group[] {
  for (const eng of engines) {
    if (eng.analysisDBGroupId === groupId) {
      delete eng.analysisDBGroupId;
      delete eng.analysisDBGroupName;
    }
  }
  return virtual.filter((g) => g.id !== groupId);
}

export function addGroup(engines: EngineEntry[], virtual: Group[], name: string, idGen: () => string): { id: string; created: boolean } {
  const existing = uniqueGroups(engines, virtual).find((g) => g.name === name);
  if (existing) return { id: existing.id, created: false };
  const id = idGen();
  virtual.push({ id, name });
  return { id, created: true };
}

export function moveEngine(engines: EngineEntry[], index: number, direction: -1 | 1): void {
  const target = index + direction;
  if (index < 0 || index >= engines.length || target < 0 || target >= engines.length) return;
  [engines[index], engines[target]] = [engines[target], engines[index]];
}

export function duplicateEngine(engines: EngineEntry[], index: number, idGen: () => string): void {
  const source = engines[index];
  if (!source) return;
  const copy: EngineEntry = JSON.parse(JSON.stringify(source));
  copy.name = `${copy.name} (Copy)`;
  copy.id = idGen();
  engines.splice(index + 1, 0, copy);
}

export type OptionRowType = "string" | "boolean" | "spin" | "combo";

export interface OptionRow {
  key: string;
  value: string | number | boolean;
  type: OptionRowType;
  min?: number;
  max?: number;
}

/** Collect option rows into an engines.json `options` object, validating ranges. */
export function collectOptions(rows: OptionRow[]): { options: Record<string, string | number | boolean>; errors: string[] } {
  const options: Record<string, string | number | boolean> = {};
  const errors: string[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.type === "boolean") {
      options[key] = row.value === true || String(row.value) === "true";
    } else if (row.type === "spin") {
      const num = Number(row.value);
      if (row.min !== undefined && row.max !== undefined && (num < row.min || num > row.max)) {
        errors.push(`${key}: ${row.min} から ${row.max} の範囲で入力してください。`);
      }
      options[key] = num;
    } else {
      options[key] = String(row.value);
    }
  }
  return { options, errors };
}

export interface EngineEditPatch {
  id: string;
  name: string;
  type: string[];
  path: string;
  options: Record<string, string | number | boolean>;
  saveAnalysisDB: boolean;
  groupId: string;
  groupName: string;
}

/**
 * Apply a modal edit onto an engine entry, preserving unknown fields.
 * The backend `normalize_engine_entry` keeps unknown keys on round-trip;
 * the UI must do the same so editing a name does not drop extra metadata.
 * DB-related keys are removed explicitly when unset (not by rebuilding).
 */
export function applyEngineEdit(original: EngineEntry | undefined, patch: EngineEditPatch): EngineEntry {
  const entry: EngineEntry = original ? { ...original } : { id: "", name: "", path: "" };
  entry.id = patch.id;
  entry.name = patch.name;
  entry.type = patch.type;
  entry.path = patch.path;
  entry.options = patch.options;
  if (patch.saveAnalysisDB) {
    delete entry.skipAnalysisDB;
  } else {
    entry.skipAnalysisDB = true;
  }
  if (patch.groupId) {
    entry.analysisDBGroupId = patch.groupId;
    if (patch.groupName) {
      entry.analysisDBGroupName = patch.groupName;
    } else {
      delete entry.analysisDBGroupName;
    }
  } else {
    delete entry.analysisDBGroupId;
    delete entry.analysisDBGroupName;
  }
  return entry;
}

/**
 * Probe generation counter. Each modal session (open/close/switch) starts a
 * new generation so a late probe result from a previous form can never
 * populate the current one. The backend still merges options; this only
 * decides whether a result belongs to the visible session.
 */
export class ProbeSession {
  private seq = 0;

  /**
   * Begin a new generation. Callers that only close a session (modal
   * close, page unload) discard the id; the increment alone invalidates
   * every in-flight probe.
   */
  next(): number {
    this.seq += 1;
    return this.seq;
  }

  /** True when `id` was issued by the latest `next()` call. */
  isCurrent(id: number): boolean {
    return id === this.seq;
  }
}

/** Engine-registry validation shared by the editor save path (backend revalidates). */
export function validateRegistry(engines: EngineEntry[], editingIndex: number, candidate: EngineEntry): string | null {
  if (!candidate.name.trim() || !candidate.id.trim() || !candidate.path.trim()) return "required";
  if (candidate.type !== undefined && candidate.type.length === 0) return "typeRequired";
  if (editingIndex < 0 && engines.some((e) => e.id === candidate.id)) return "duplicateId";
  return null;
}
