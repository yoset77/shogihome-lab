import { describe, expect, it } from "vitest";
import type { EngineEntry } from "./api";
import {
  addGroup,
  applyEngineEdit,
  collectEngineResource,
  collectOptions,
  defaultResourceGroup,
  defaultResourceGroupName,
  deleteEngineIfConfirmed,
  deleteGroup,
  deleteResourceGroupIfConfirmed,
  duplicateEngine,
  engineDisplayCost,
  generateId,
  MAX_RESOURCE_BUDGET,
  moveEngine,
  isImeComposingKey,
  normalizeGroupName,
  normalizeResourceSettings,
  normalizeType,
  ProbeSession,
  readEngineResource,
  readThreadsLinkedCost,
  renameGroup,
  uniqueGroups,
  validateRegistry,
  validateResourceBudget,
  withDefaultResourceGroup,
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

  it("normalizes modal group-name input (window.prompt replacement)", () => {
    expect(normalizeGroupName("  G1  ")).toBe("G1");
    expect(normalizeGroupName("")).toBeNull();
    expect(normalizeGroupName("   ")).toBeNull();
    expect(normalizeGroupName(null)).toBeNull();
    expect(normalizeGroupName(undefined)).toBeNull();
  });

  it("ignores Enter/Escape while IME composition is in progress", () => {
    // Confirming a kana-kanji conversion fires keydown Enter; cancelling it
    // fires Escape. Neither may submit or close the group-name modal.
    expect(isImeComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposingKey({ isComposing: true, keyCode: 27 })).toBe(true);
    // WebKit reports keyCode 229 during composition.
    expect(isImeComposingKey({ keyCode: 229 })).toBe(true);
    expect(isImeComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposingKey({ isComposing: false, keyCode: 27 })).toBe(false);
    expect(isImeComposingKey({})).toBe(false);
  });

  it("covers the create/assign/rename flow the modal drives", () => {
    const engines = [engine({ id: "e1" })];
    const virtual: { id: string; name: string }[] = [];
    const created = addGroup(engines, virtual, normalizeGroupName(" G1 ")!, () => "g1");
    expect(created).toEqual({ id: "g1", created: true });
    const edited = applyEngineEdit(engines[0], {
      id: "e1",
      name: "Engine",
      type: ["game"],
      path: "/bin/engine",
      options: {},
      saveAnalysisDB: true,
      groupId: "g1",
      groupName: "G1",
    });
    engines[0] = edited;
    renameGroup(engines, virtual, "g1", normalizeGroupName("G1b")!);
    expect(engines[0].analysisDBGroupName).toBe("G1b");
    expect(uniqueGroups(engines, virtual)).toEqual([{ id: "g1", name: "G1b" }]);
  });
});

describe("applyEngineEdit", () => {
  it("preserves unknown fields when editing known fields", () => {
    const original = engine({
      name: "Old",
      customMeta: "keep-me",
      analysisDBGroupId: "g1",
      analysisDBGroupName: "G1",
    } as Partial<EngineEntry>);
    const next = applyEngineEdit(original, {
      id: "e1",
      name: "New",
      type: ["game"],
      path: "/bin/engine",
      options: {},
      saveAnalysisDB: true,
      groupId: "g1",
      groupName: "G1",
    });
    expect(next.name).toBe("New");
    expect(next.customMeta).toBe("keep-me");
    expect(next.analysisDBGroupId).toBe("g1");
  });

  it("removes DB keys explicitly when unset", () => {
    const original = engine({
      skipAnalysisDB: undefined,
      analysisDBGroupId: "g1",
      analysisDBGroupName: "G1",
    });
    const next = applyEngineEdit(original, {
      id: "e1",
      name: "Engine",
      type: ["game"],
      path: "/bin/engine",
      options: {},
      saveAnalysisDB: false,
      groupId: "",
      groupName: "",
    });
    expect(next.skipAnalysisDB).toBe(true);
    expect(next.analysisDBGroupId).toBeUndefined();
    expect(next.analysisDBGroupName).toBeUndefined();
  });
});

describe("ProbeSession", () => {
  it("invalidates the previous form's probe when a session ends or a new one starts", () => {
    const session = new ProbeSession();
    // Engine A edit starts a probe.
    const probeA = session.next();
    expect(session.isCurrent(probeA)).toBe(true);
    // Closing the modal (cancel, backdrop, or save) retires it.
    session.next();
    expect(session.isCurrent(probeA)).toBe(false);
    // Engine B add starts a probe; reopening another form retires that too.
    const probeB = session.next();
    expect(session.isCurrent(probeB)).toBe(true);
    session.next();
    expect(session.isCurrent(probeB)).toBe(false);
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

describe("deleteEngineIfConfirmed", () => {
  it("keeps the entry while confirmation is pending", async () => {
    const list = [engine({ id: "a" }), engine({ id: "b" })];
    let resolve!: (value: boolean) => void;
    const pending = deleteEngineIfConfirmed(
      list,
      0,
      () => new Promise<boolean>((r) => { resolve = r; }),
    );
    // Let any synchronous prefix run: the list must still be intact until
    // the dialog settles. Dropping the `await` at the call site would
    // delete here instead.
    await new Promise((r) => setTimeout(r, 10));
    expect(list.map((e) => e.id)).toEqual(["a", "b"]);
    resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(list.map((e) => e.id)).toEqual(["b"]);
  });

  it("keeps the entry on decline or dialog error", async () => {
    const declined = [engine({ id: "a" })];
    await expect(deleteEngineIfConfirmed(declined, 0, async () => false)).resolves.toBe(false);
    expect(declined.map((e) => e.id)).toEqual(["a"]);
    const failed = [engine({ id: "a" })];
    await expect(
      deleteEngineIfConfirmed(failed, 0, async () => { throw new Error("denied"); }),
    ).resolves.toBe(false);
    expect(failed.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("resource settings", () => {
  it("normalizes saved settings and rejects malformed shapes", () => {
    expect(normalizeResourceSettings(undefined)).toEqual({ enabled: false, groups: [] });
    expect(
      normalizeResourceSettings({
        enabled: true,
        groups: [{ id: "local", name: "Local CPU", budget: 16, extra: true }],
      }),
    ).toEqual({
      enabled: true,
      groups: [{ id: "local", name: "Local CPU", budget: 16, extra: true }],
    });
    for (const invalid of [
      null,
      { enabled: "yes", groups: [] },
      { enabled: true, groups: [{ id: "", name: "n", budget: 1 }] },
      { enabled: true, groups: [{ id: "g", name: "n", budget: 0 }] },
      { enabled: true, groups: [{ id: "g", name: "n" }] },
      { enabled: true, groups: "nope" },
    ]) {
      expect(normalizeResourceSettings(invalid)).toEqual({ enabled: false, groups: [] });
    }
  });

  it("proposes a default local CPU group from the machine's core count", () => {
    expect(defaultResourceGroup(32, "ja")).toEqual({
      id: "local-cpu",
      name: "ローカル CPU",
      budget: 32,
    });
    expect(defaultResourceGroup(0, "en")!.budget).toBe(1);
    expect(defaultResourceGroup(1_000_000, "en")!.budget).toBe(MAX_RESOURCE_BUDGET);
  });

  it("collects engine assignments and reports invalid manual costs", () => {
    const errors: string[] = [];
    expect(collectEngineResource({ groupId: "", autoThreads: true, cost: 1 }, errors)).toBeUndefined();
    expect(
      collectEngineResource({ groupId: "g", autoThreads: true, cost: 0 }, errors),
    ).toEqual({ groupId: "g", autoThreads: true });
    expect(errors).toEqual([]);
    expect(
      collectEngineResource({ groupId: "g", autoThreads: false, cost: 4 }, errors),
    ).toEqual({ groupId: "g", autoThreads: false, cost: 4 });
    expect(
      collectEngineResource({ groupId: "g", autoThreads: false, cost: 0 }, errors),
    ).toBeUndefined();
    expect(errors.length).toBe(1);
  });

  it("follows Threads for the default cost mode regardless of file type", () => {
    expect(readEngineResource({ id: "a", name: "A", path: "engine.exe" })).toEqual({
      groupId: "",
      autoThreads: false,
      cost: 1,
    });
    expect(
      readEngineResource({
        id: "a",
        name: "A",
        path: "run.bat",
        options: { Threads: 8 },
      }),
    ).toEqual({ groupId: "", autoThreads: true, cost: 8 });
    expect(
      readEngineResource({
        id: "a",
        name: "A",
        path: "engine.exe",
        resource: { groupId: "g", autoThreads: false, cost: 3 },
      }),
    ).toEqual({ groupId: "g", autoThreads: false, cost: 3 });
    // applyEngineEdit carries and clears the resource field.
    const entry = applyEngineEdit(undefined, {
      id: "a",
      name: "A",
      type: ["game"],
      path: "engine.exe",
      options: {},
      saveAnalysisDB: true,
      groupId: "",
      groupName: "",
      resource: { groupId: "g", autoThreads: true },
    });
    expect(entry.resource).toEqual({ groupId: "g", autoThreads: true });
    const cleared = applyEngineEdit(entry, {
      id: "a",
      name: "A",
      type: ["game"],
      path: "engine.exe",
      options: {},
      saveAnalysisDB: true,
      groupId: "",
      groupName: "",
    });
    expect(cleared.resource).toBeUndefined();
  });

  it("validates group budget inputs", () => {
    expect(validateResourceBudget("16")).toBe(16);
    expect(validateResourceBudget("0")).toBeUndefined();
    expect(validateResourceBudget("-1")).toBeUndefined();
    expect(validateResourceBudget("1.5")).toBeUndefined();
    expect(validateResourceBudget("100001")).toBeUndefined();
  });

  it("reports the effective cost of each engine", () => {
    expect(engineDisplayCost(engine())).toBeUndefined();
    expect(engineDisplayCost(engine({ resource: { groupId: "g", autoThreads: true }, options: { Threads: 4 } }))).toBe(4);
    expect(engineDisplayCost(engine({ resource: { groupId: "g", autoThreads: true }, options: { Threads: 0 } }))).toBeUndefined();
    expect(engineDisplayCost(engine({ resource: { groupId: "g", autoThreads: false, cost: 2 } }))).toBe(2);
    expect(engineDisplayCost(engine({ resource: { groupId: "g", autoThreads: false } }))).toBeUndefined();
    // The Threads option only counts as a number (a string cannot be costed).
    expect(engineDisplayCost(engine({ resource: { groupId: "g", autoThreads: true }, options: { Threads: "4" } }))).toBeUndefined();
  });

  it.each([0, -1, 1.5, NaN, Infinity, MAX_RESOURCE_BUDGET + 1, "4"])(
    "does not resolve invalid Threads %s for defaults or display",
    (threads) => {
      const entry = engine({ options: { Threads: threads } });
      expect(readThreadsLinkedCost(entry)).toBeUndefined();
      expect(readEngineResource(entry).autoThreads).toBe(false);
      entry.resource = { groupId: "g", autoThreads: true };
      expect(engineDisplayCost(entry)).toBeUndefined();
    },
  );

  it.each([1, MAX_RESOURCE_BUDGET])("accepts valid linked Threads boundary %s", (threads) => {
    const entry = engine({ options: { Threads: threads } });
    expect(readThreadsLinkedCost(entry)).toBe(threads);
    expect(readEngineResource(entry).autoThreads).toBe(true);
    entry.resource = { groupId: "g", autoThreads: true };
    expect(engineDisplayCost(entry)).toBe(threads);
  });

  it("names new resource groups per language", () => {
    expect(defaultResourceGroupName(1, "ja")).toBe("グループ 1");
    expect(defaultResourceGroupName(2, "en")).toBe("Group 2");
  });

  it("seeds a default group only while none exists", () => {
    expect(withDefaultResourceGroup({ enabled: false, groups: [] }, 8, "en")).toEqual({
      enabled: false,
      groups: [{ id: "local-cpu", name: "Local CPU", budget: 8 }],
    });
    const existing = normalizeResourceSettings({
      enabled: true,
      groups: [{ id: "g", name: "GPU", budget: 2 }],
    });
    expect(withDefaultResourceGroup(existing, 8, "en")).toEqual(existing);
  });
});

describe("deleteResourceGroupIfConfirmed", () => {
  const setup = () => {
    const resources = normalizeResourceSettings({
      enabled: true,
      groups: [{ id: "g", name: "CPU", budget: 8 }],
    });
    const engines = [
      engine({ id: "managed", resource: { groupId: "g", autoThreads: true } }),
      engine({ id: "free" }),
    ];
    return { resources, engines };
  };

  it("keeps the group and its assignments while confirmation is pending", async () => {
    const { resources, engines } = setup();
    let settle: (ok: boolean) => void = () => undefined;
    const pending = deleteResourceGroupIfConfirmed(resources, engines, "g", () =>
      new Promise<boolean>((resolve) => { settle = resolve; }),
    );
    await Promise.resolve();
    expect(resources.groups).toHaveLength(1);
    expect(engines[0].resource).toEqual({ groupId: "g", autoThreads: true });
    settle(true);
    expect(await pending).toBe(true);
  });

  it("removes the group and unassigns its engines once confirmed", async () => {
    const { resources, engines } = setup();
    expect(await deleteResourceGroupIfConfirmed(resources, engines, "g", async () => true)).toBe(true);
    expect(resources.groups).toEqual([]);
    expect(engines[0].resource).toBeUndefined();
    expect(engines[1].resource).toBeUndefined();
  });

  it("keeps everything on decline, dialog error, or unknown group", async () => {
    const { resources, engines } = setup();
    expect(await deleteResourceGroupIfConfirmed(resources, engines, "g", async () => false)).toBe(false);
    expect(
      await deleteResourceGroupIfConfirmed(resources, engines, "g", async () => {
        throw new Error("dialog failed");
      }),
    ).toBe(false);
    expect(await deleteResourceGroupIfConfirmed(resources, engines, "missing", async () => true)).toBe(false);
    expect(resources.groups).toHaveLength(1);
    expect(engines[0].resource).toEqual({ groupId: "g", autoThreads: true });
  });
});
