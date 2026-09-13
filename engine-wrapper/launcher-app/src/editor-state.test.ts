import { describe, expect, it } from "vitest";
import type { EngineEntry } from "./api";
import {
  addGroup,
  collectOptions,
  deleteGroup,
  duplicateEngine,
  generateId,
  moveEngine,
  normalizeType,
  renameGroup,
  uniqueGroups,
  validateRegistry,
} from "./editor-state";

const engine = (overrides: Partial<EngineEntry> = {}): EngineEntry => ({
  id: "e1",
  name: "Engine",
  path: "/bin/engine",
  type: ["game"],
  ...overrides,
});

describe("normalizeType", () => {
  it("handles legacy forms", () => {
    expect(normalizeType("both")).toEqual(["game", "mate", "research"]);
    expect(normalizeType(undefined)).toEqual(["game", "mate", "research"]);
    expect(normalizeType("game")).toEqual(["game"]);
    expect(normalizeType(["research", "game", "game"])).toEqual(["game", "research"]);
    expect(normalizeType(["bogus"])).toEqual([]);
  });
});

describe("engine list ops", () => {
  it("moves and duplicates with fresh ids", () => {
    const list = [engine({ id: "a" }), engine({ id: "b" })];
    moveEngine(list, 0, 1);
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
    moveEngine(list, 0, -1);
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
    duplicateEngine(list, 0, () => "copy-id");
    expect(list[1].id).toBe("copy-id");
    expect(list[1].name).toContain("(Copy)");
  });

  it("validates the registry", () => {
    const list = [engine({ id: "a" })];
    expect(validateRegistry(list, -1, engine({ id: "a" }))).toBe("duplicateId");
    expect(validateRegistry(list, 0, engine({ id: "a" }))).toBeNull();
    expect(validateRegistry(list, -1, engine({ name: "" }))).toBe("required");
    expect(validateRegistry(list, -1, engine({ type: [] }))).toBe("typeRequired");
  });

  it("generates sortable unique ids", () => {
    const ids = new Set([generateId(), generateId(), generateId()]);
    expect(ids.size).toBe(3);
    expect(generateId((n) => new Array(n).fill(7))).toMatch(/^[0-9A-Z]{26}$/);
  });
});

describe("groups", () => {
  it("merges engine and virtual groups, renames, deletes", () => {
    const engines = [engine({ analysisDBGroupId: "g1", analysisDBGroupName: "G1" })];
    const virtual = [{ id: "g2", name: "G2" }];
    expect(uniqueGroups(engines, virtual)).toHaveLength(2);
    renameGroup(engines, virtual, "g1", "G1b");
    expect(engines[0].analysisDBGroupName).toBe("G1b");
    const rest = deleteGroup(engines, virtual, "g1");
    expect(engines[0].analysisDBGroupId).toBeUndefined();
    expect(rest).toHaveLength(1);
    const created = addGroup(engines, rest, "G3", () => "g3");
    expect(created).toEqual({ id: "g3", created: true });
    expect(addGroup(engines, rest, "G2", () => "nope")).toEqual({ id: "g2", created: false });
  });
});

describe("collectOptions", () => {
  it("collects typed values and reports range errors", () => {
    const { options, errors } = collectOptions([
      { key: "USI_Ponder", value: true, type: "boolean" },
      { key: "Threads", value: "8", type: "spin", min: 1, max: 128 },
      { key: "Bad", value: "999", type: "spin", min: 1, max: 2 },
      { key: "", value: "x", type: "string" },
      { key: "Book", value: "a.bin", type: "string" },
    ]);
    expect(options).toEqual({ USI_Ponder: true, Threads: 8, Bad: 999, Book: "a.bin" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Bad");
  });
});
