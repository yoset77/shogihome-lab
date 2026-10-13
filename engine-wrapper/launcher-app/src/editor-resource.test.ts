// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { api, type EngineEntry } from "./api";
import { confirmAction } from "./confirm";
import { initEditor } from "./editor";
import { text } from "./i18n";

vi.mock("./api", () => ({
  api: {
    getUiLanguage: vi.fn(async () => "en"),
    setUiLanguage: vi.fn(async () => {}),
    editorLoad: vi.fn(),
    editorSave: vi.fn(async () => {}),
    resourceCores: vi.fn(async () => 8),
    editorProbe: vi.fn(async () => {
      throw new Error("No engine in DOM tests");
    }),
    editorRefresh: vi.fn(),
    editorBrowse: vi.fn(),
  },
}));
vi.mock("./confirm", () => ({ confirmAction: vi.fn(async () => true) }));

const html = readFileSync(
  new NodeURL("../editor.html", import.meta.url),
  "utf8",
);
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const resources = {
  enabled: true,
  groups: [{ id: "g", name: "CPU", budget: 8 }],
};

describe("resource editor DOM", () => {
  let listeners: MockInstance<Window["addEventListener"]>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = html;
    listeners = vi.spyOn(window, "addEventListener");
  });
  afterEach(() => {
    for (const [event, listener, options] of listeners.mock.calls)
      window.removeEventListener(event, listener, options);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function load(engines: EngineEntry[] = [], enabled = true) {
    vi.mocked(api.editorLoad).mockResolvedValue({
      engines,
      resources: { ...structuredClone(resources), enabled },
    });
    initEditor();
    await vi.waitFor(() =>
      expect($<HTMLButtonElement>("saveBtn").disabled).toBe(false),
    );
  }
  function changePath(path: string) {
    $<HTMLInputElement>("editPath").value = path;
    $("editPath").dispatchEvent(new Event("change"));
  }
  function addThreadsOption(value: number) {
    $("addSpinOptionBtn").click();
    const row = document.querySelector<HTMLDivElement>(
      "#optionsList .option-row:last-child",
    )!;
    row.querySelector<HTMLInputElement>(".opt-key")!.value = "Threads";
    row.querySelector<HTMLInputElement>(".opt-key")!.dispatchEvent(new Event("input"));
    const input = row.querySelector<HTMLInputElement>(".opt-val")!;
    input.value = String(value);
    input.dispatchEvent(new Event("input"));
  }
  function assign() {
    $<HTMLSelectElement>("editResourceGroupId").value = "g";
    $("editResourceGroupId").dispatchEvent(new Event("change"));
  }
  async function saveEngine() {
    $("saveEngineBtn").click();
    $("saveBtn").click();
    await vi.waitFor(() => expect(api.editorSave).toHaveBeenCalledOnce());
    return vi.mocked(api.editorSave).mock.calls[0][0][0];
  }

  it("defaults a newly entered engine without Threads to manual before and after group assignment", async () => {
    await load();
    $("addEngineBtn").click();
    $<HTMLInputElement>("editName").value = "Engine";
    changePath("engine.exe");
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
    assign();
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
    expect((await saveEngine()).resource).toEqual({
      groupId: "g",
      autoThreads: false,
      cost: 1,
    });
  });

  it("keeps an unassigned existing engine's manual default without Threads", async () => {
    await load([{ id: "engine", name: "Engine", path: "engine.exe" }]);
    document
      .querySelector<HTMLButtonElement>("#engineTable .btn-primary")!
      .click();
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
    assign();
    expect((await saveEngine()).resource?.autoThreads).toBe(false);
  });

  it("preserves an explicit Threads choice across path and group changes", async () => {
    await load([
      {
        id: "engine",
        name: "Engine",
        path: "engine.exe",
        options: { Threads: 2 },
        resource: { groupId: "g", autoThreads: true },
      },
    ]);
    document
      .querySelector<HTMLButtonElement>("#engineTable .btn-primary")!
      .click();
    changePath("other.exe");
    $<HTMLSelectElement>("editResourceGroupId").value = "";
    $("editResourceGroupId").dispatchEvent(new Event("change"));
    assign();
    expect($<HTMLInputElement>("resourceCostThreads").checked).toBe(true);
    const saved = await saveEngine();
    expect(saved.resource?.autoThreads).toBe(true);
    expect(saved.path).toBe("other.exe");
  });

  it("allows a new engine to explicitly choose Threads without later path changes undoing it", async () => {
    await load();
    $("addEngineBtn").click();
    $<HTMLInputElement>("editName").value = "Engine";
    changePath("engine.exe");
    assign();
    addThreadsOption(2);
    $("resourceCostThreads").click();
    changePath("another.exe");
    expect((await saveEngine()).resource?.autoThreads).toBe(true);
  });

  it("allows a normal executable to explicitly choose a manual cost", async () => {
    await load();
    $("addEngineBtn").click();
    $<HTMLInputElement>("editName").value = "Engine";
    addThreadsOption(4);
    changePath("engine.exe");
    assign();
    expect($<HTMLInputElement>("resourceCostThreads").checked).toBe(true);
    $("resourceCostManual").click();
    $<HTMLInputElement>("editResourceCost").value = "5";
    changePath("another.exe");
    expect((await saveEngine()).resource).toEqual({
      groupId: "g",
      autoThreads: false,
      cost: 5,
    });
  });

  it("does not save a resource assignment for an unmanaged engine", async () => {
    await load();
    $("addEngineBtn").click();
    $<HTMLInputElement>("editName").value = "Unmanaged";
    changePath("engine.exe");
    expect((await saveEngine()).resource).toBeUndefined();
  });

  async function budgetInput() {
    await load();
    $("resourceSettingsBtn").click();
    await vi.waitFor(() =>
      expect($("resourceModal").style.display).toBe("block"),
    );
    return document.querySelector<HTMLInputElement>(
      '#resourceGroupTable input[type="number"]',
    )!;
  }

  it.each(["0", "", "1.5", "100001"])(
    "blocks closing and saving an invalid budget %s",
    async (raw) => {
      const input = await budgetInput();
      input.value = raw;
      input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new Event("change"));
      $("closeResourceModalBtn").click();
      expect($("resourceModal").style.display).toBe("block");
      expect($("toastContainer").textContent).toContain("CPU");
      $("saveBtn").click();
      await Promise.resolve();
      expect(api.editorSave).not.toHaveBeenCalled();
    },
  );

  it("does not discard invalid input when toggling enforcement or adding a group", async () => {
    const input = await budgetInput();
    input.value = "0";
    input.dispatchEvent(new Event("input"));
    $("resourceEnabled").dispatchEvent(new Event("change"));
    $("resourceAddGroupBtn").click();
    expect(
      document.querySelector<HTMLInputElement>(
        '#resourceGroupTable input[type="number"]',
      )!.value,
    ).toBe("0");
    $("saveBtn").click();
    await Promise.resolve();
    expect(api.editorSave).not.toHaveBeenCalled();
  });

  it("saves the corrected input rather than the previous budget without relying on change", async () => {
    const input = await budgetInput();
    input.value = "0";
    input.dispatchEvent(new Event("input"));
    $("closeResourceModalBtn").click();
    input.value = "12";
    input.dispatchEvent(new Event("input"));
    $("closeResourceModalBtn").click();
    expect($("resourceModal").style.display).toBe("none");
    $("saveBtn").click();
    await vi.waitFor(() => expect(api.editorSave).toHaveBeenCalledOnce());
    expect(vi.mocked(api.editorSave).mock.calls[0][1]).toMatchObject({
      groups: [{ budget: 12 }],
    });
  });

  it("marks an invalid budget inline while the modal stays open", async () => {
    const input = await budgetInput();
    input.value = "0";
    input.dispatchEvent(new Event("input"));
    expect(input.dataset.invalid).toBe("true");
    const error = input.closest("td")!.querySelector<HTMLElement>(".field-error")!;
    expect(error.textContent).toBe(text("editor.resourceBudgetInvalid", "en", "CPU"));
    input.value = "8";
    input.dispatchEvent(new Event("input"));
    expect(input.dataset.invalid).toBe("false");
    expect(error.textContent).toBe("");
  });

  it("hides the cost row until a group is selected and previews the linked Threads", async () => {
    await load([
      {
        id: "e",
        name: "Engine",
        path: "engine.exe",
        options: { Threads: 4 },
        resource: { groupId: "g", autoThreads: true },
      },
    ]);
    document
      .querySelector<HTMLButtonElement>("#engineTable .btn-primary")!
      .click();
    expect($("resourceCostRow").style.display).not.toBe("none");
    expect($("resourceCostPreview").textContent).toBe(
      text("editor.resourceThreadsLinked", "en", "4"),
    );
    $<HTMLSelectElement>("editResourceGroupId").value = "";
    $("editResourceGroupId").dispatchEvent(new Event("change"));
    expect($("resourceCostRow").style.display).toBe("none");
    expect($("resourceGroupHint").textContent).toContain(
      text("editor.resourceNoGroupHint", "en"),
    );
    assign();
    expect($("resourceCostRow").style.display).not.toBe("none");
  });

  it.each(["spin", "string"])(
    "validates the last Threads row rather than an earlier valid row (%s)",
    async (type) => {
      await load([{
        id: "e", name: "Engine", path: "engine.exe",
        options: { Threads: 4 }, resource: { groupId: "g", autoThreads: true },
      }]);
      document.querySelector<HTMLButtonElement>("#engineTable .btn-primary")!.click();
      $(type === "spin" ? "addSpinOptionBtn" : "addStringOptionBtn").click();
      const row = document.querySelector("#optionsList .option-row:last-child")!;
      row.querySelector<HTMLInputElement>(".opt-key")!.value = "Threads";
      row.querySelector<HTMLInputElement>(".opt-val")!.value = type === "spin" ? "0" : "4";
      $("saveEngineBtn").click();
      expect($("engineModal").style.display).toBe("block");
      expect($("toastContainer").textContent).toContain(
        text("editor.resourceThreadsRequired", "en", "Engine"),
      );
    },
  );

  it("previews and saves the last valid Threads row", async () => {
    await load([{
      id: "e", name: "Engine", path: "engine.exe",
      options: { Threads: 4 }, resource: { groupId: "g", autoThreads: true },
    }]);
    document.querySelector<HTMLButtonElement>("#engineTable .btn-primary")!.click();
    addThreadsOption(8);
    expect($("resourceCostPreview").textContent).toBe(text("editor.resourceThreadsLinked", "en", "8"));
    expect((await saveEngine()).options?.Threads).toBe(8);
  });

  it.each([0, 1.5, 100001])("blocks an invalid linked Threads value %s", async (threads) => {
    await load([{
      id: "e", name: "Engine", path: "engine.exe",
      options: { Threads: threads }, resource: { groupId: "g", autoThreads: true },
    }]);
    document.querySelector<HTMLButtonElement>("#engineTable .btn-primary")!.click();
    $("saveEngineBtn").click();
    expect($("engineModal").style.display).toBe("block");
    expect($("toastContainer").textContent).toContain(
      text("editor.resourceThreadsRequired", "en", "Engine"),
    );
  });

  it("updates the preview and hint when Threads is edited, renamed, or deleted", async () => {
    await load([{
      id: "e", name: "Engine", path: "engine.exe",
      options: { Threads: 4 }, resource: { groupId: "g", autoThreads: true },
    }]);
    document.querySelector<HTMLButtonElement>("#engineTable .btn-primary")!.click();
    const row = document.querySelector("#optionsList .option-row")!;
    const input = row.querySelector<HTMLInputElement>(".opt-val")!;
    input.value = "8";
    input.dispatchEvent(new Event("input"));
    expect($("resourceCostPreview").textContent).toBe(text("editor.resourceThreadsLinked", "en", "8"));
    input.value = "0";
    input.dispatchEvent(new Event("change"));
    expect($("resourceCostPreview").textContent).toBe("");
    expect($("resourceGroupHint").textContent).toContain(text("editor.resourceThreadsUnresolved", "en"));
    input.value = "4";
    input.dispatchEvent(new Event("input"));
    const key = row.querySelector<HTMLInputElement>(".opt-key")!;
    key.value = "Other";
    key.dispatchEvent(new Event("input"));
    expect($("resourceCostPreview").textContent).toBe("");
    key.value = "Threads";
    key.dispatchEvent(new Event("change"));
    expect($("resourceCostPreview").textContent).toBe(text("editor.resourceThreadsLinked", "en", "4"));
    row.querySelector<HTMLButtonElement>(".btn-danger")!.click();
    expect($("resourceCostPreview").textContent).toBe("");
    expect($("resourceGroupHint").textContent).toContain(text("editor.resourceThreadsUnresolved", "en"));
    expect($<HTMLInputElement>("resourceCostThreads").checked).toBe(true);
  });

  it("re-evaluates default cost modes after option changes but preserves explicit choices", async () => {
    await load();
    $("addEngineBtn").click();
    changePath("engine.exe");
    assign();
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
    addThreadsOption(4);
    expect($<HTMLInputElement>("resourceCostThreads").checked).toBe(true);
    const input = document.querySelector<HTMLInputElement>("#optionsList .opt-val")!;
    input.value = "0";
    input.dispatchEvent(new Event("input"));
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
    input.value = "8";
    input.dispatchEvent(new Event("input"));
    expect($<HTMLInputElement>("resourceCostThreads").checked).toBe(true);
    $("resourceCostManual").click();
    input.value = "4";
    input.dispatchEvent(new Event("input"));
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
  });

  it("refreshes linked cost after individual and bulk option resets", async () => {
    vi.mocked(api.editorProbe).mockResolvedValueOnce([
      1, { Threads: { type: "spin", default: "2", min: 0, max: 100000 } }, ["Threads"],
    ]);
    vi.mocked(api.editorRefresh).mockResolvedValueOnce({ values: { Threads: 4 }, order: ["Threads"] });
    await load([{
      id: "e", name: "Engine", path: "engine.exe",
      options: { Threads: 4 }, resource: { groupId: "g", autoThreads: true },
    }]);
    document.querySelector<HTMLButtonElement>("#engineTable .btn-primary")!.click();
    await vi.waitFor(() => expect($("resetAllBtn").style.display).toBe("block"));
    const row = document.querySelector("#optionsList .option-row")!;
    row.querySelector<HTMLButtonElement>(".btn-warning")!.click();
    expect($("resourceCostPreview").textContent).toBe(text("editor.resourceThreadsLinked", "en", "2"));
    const input = row.querySelector<HTMLInputElement>(".opt-val")!;
    input.value = "8";
    input.dispatchEvent(new Event("input"));
    $("resetAllBtn").click();
    await vi.waitFor(() => expect(input.value).toBe("2"));
    expect($("resourceCostPreview").textContent).toBe(text("editor.resourceThreadsLinked", "en", "2"));
  });

  it("defaults to a manual cost when Threads is unresolved and blocks saving it as auto", async () => {
    await load();
    $("addEngineBtn").click();
    $<HTMLInputElement>("editName").value = "Engine";
    changePath("engine.exe");
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
    assign();
    $("resourceCostThreads").click();
    $("saveEngineBtn").click();
    expect($("engineModal").style.display).toBe("block");
    expect($("toastContainer").textContent).toContain(
      text("editor.resourceThreadsRequired", "en", "Engine"),
    );
    addThreadsOption(4);
    $("saveEngineBtn").click();
    expect($("engineModal").style.display).toBe("none");
    $("saveBtn").click();
    await vi.waitFor(() => expect(api.editorSave).toHaveBeenCalledOnce());
    expect(vi.mocked(api.editorSave).mock.calls[0][0][0].resource).toEqual({
      groupId: "g",
      autoThreads: true,
    });
  });

  it("keeps the edit but warns when a cost exceeds the group budget", async () => {
    await load();
    $("addEngineBtn").click();
    $<HTMLInputElement>("editName").value = "Big";
    changePath("engine.exe");
    assign();
    $("resourceCostManual").click();
    $<HTMLInputElement>("editResourceCost").value = "9";
    expect((await saveEngine()).resource).toEqual({
      groupId: "g",
      autoThreads: false,
      cost: 9,
    });
    expect($("toastContainer").textContent).toContain(
      text("editor.resourceCostOverBudget", "en", "Big", "9", "CPU", "8"),
    );
  });

  it("does not warn when the assigned costs sum above the group budget", async () => {
    await load([
      {
        id: "a",
        name: "A",
        path: "a.exe",
        resource: { groupId: "g", autoThreads: false, cost: 5 },
      },
      {
        id: "b",
        name: "B",
        path: "b.exe",
        resource: { groupId: "g", autoThreads: false, cost: 4 },
      },
    ]);
    $("saveBtn").click();
    await vi.waitFor(() => expect(api.editorSave).toHaveBeenCalledOnce());
    expect($("toastContainer").textContent).toBe(`${text("editor.saved", "en")}×`);
  });

  it("keeps the engine modal open on a backdrop click", async () => {
    await load();
    $("addEngineBtn").click();
    $("engineModal").click();
    expect($("engineModal").style.display).toBe("block");
  });

  it("keeps Apply and Cancel outside the scrolling engine form body", async () => {
    await load();
    const body = document.querySelector("#engineModal .modal-body")!;
    const footer = document.querySelector("#engineModal .modal-footer")!;
    expect(body.contains($("saveEngineBtn"))).toBe(false);
    expect(body.contains($("cancelModalBtn"))).toBe(false);
    expect(footer.contains($("saveEngineBtn"))).toBe(true);
    expect(footer.contains($("cancelModalBtn"))).toBe(true);
  });

  it("lists engine types by label without internal values", async () => {
    await load([{
      id: "e", name: "Engine", path: "engine.exe",
      type: ["game", "research", "mate"],
    }]);
    expect(document.querySelector("#engineTable tbody td:nth-child(2)")!.textContent)
      .toBe("Game, Research, Mate");
  });

  it("uses the same type labels in the engine dialog", async () => {
    await load();
    expect(["typeGameLabel", "typeResearchLabel", "typeMateLabel"].map((id) => $(id).textContent))
      .toEqual(["Game", "Research", "Mate"]);
  });

  it("updates the analysis-DB label when its checkbox is toggled", async () => {
    await load([{ id: "e", name: "Engine", path: "engine.exe", type: ["game"] }]);
    document.querySelector<HTMLButtonElement>("#engineTable .btn-primary")!.click();
    expect($("editSaveAnalysisDBLabel").textContent).toBe("true");
    document.querySelector<HTMLLabelElement>("#engineModal .save-db-row > label.check")!.click();
    expect($<HTMLInputElement>("editSaveAnalysisDB").checked).toBe(false);
    expect($("editSaveAnalysisDBLabel").textContent).toBe("false");
    document.querySelector<HTMLLabelElement>("#engineModal .save-db-row > label.check")!.click();
    expect($("editSaveAnalysisDBLabel").textContent).toBe("true");
  });

  it("gives each engine badge the full text as a tooltip", async () => {
    await load([{
      id: "e", name: "Engine", path: "engine.exe", type: ["game"],
      skipAnalysisDB: true,
      analysisDBGroupId: "grp", analysisDBGroupName: "A very long analysis group name",
    }]);
    const badges = [...document.querySelectorAll<HTMLElement>("#engineTable tbody .engine-badges .engine-badge")];
    expect(badges.map((b) => b.textContent)).toEqual([
      "No DB",
      "Group: A very long analysis group name",
    ]);
    expect(badges.map((b) => b.title)).toEqual(badges.map((b) => b.textContent));
  });

  it.each([{ cost: 9, other: 0 }, { cost: 5, other: 4 }])(
    "does not warn about budgets while limits are disabled (%j)",
    async ({ cost, other }) => {
      const engines: EngineEntry[] = [{
        id: "e", name: "Engine", path: "engine.exe",
        resource: { groupId: "g", autoThreads: false, cost },
      }];
      if (other) engines.push({
        id: "other", name: "Other", path: "other.exe",
        resource: { groupId: "g", autoThreads: false, cost: other },
      });
      await load(engines, false);
      document.querySelector<HTMLButtonElement>("#engineTable .btn-primary")!.click();
      $("saveEngineBtn").click();
      expect($("engineModal").style.display).toBe("none");
      expect($("toastContainer").textContent).toBe("");
      $("saveBtn").click();
      await vi.waitFor(() => expect(api.editorSave).toHaveBeenCalledOnce());
      expect($("toastContainer").textContent).toBe(`${text("editor.saved", "en")}×`);
      expect(vi.mocked(api.editorSave).mock.calls[0][1]).toMatchObject({ enabled: false });
    },
  );

  it("renders resource groups and costs on separate plain-text lines", async () => {
    await load([
      {
        id: "a",
        name: "A",
        path: "a.exe",
        options: { Threads: 4 },
        resource: { groupId: "g", autoThreads: true },
      },
      {
        id: "b",
        name: "B",
        path: "b.exe",
        resource: { groupId: "g", autoThreads: false, cost: 2 },
      },
      { id: "c", name: "C", path: "c.exe", resource: { groupId: "g", autoThreads: true } },
      { id: "d", name: "D", path: "d.exe" },
    ]);
    const cells = [...document.querySelectorAll("#engineTable tbody td:nth-child(3)")];
    expect(cells.map((c) => c.querySelector(".resource-group")?.textContent ?? "")).toEqual([
      "CPU", "CPU", "CPU", "",
    ]);
    expect(cells.map((c) => c.querySelector(".resource-cost")?.textContent ?? "")).toEqual([
      text("editor.resourceCellAuto", "en", "4"),
      text("editor.resourceCellManual", "en", "2"),
      text("editor.resourceCellAutoUnknown", "en"),
      "",
    ]);
    for (const cell of cells.slice(0, 3)) {
      expect(cell.children).toHaveLength(2);
      expect(cell.querySelector(".resource-group")?.getAttribute("title")).toBe("CPU");
      expect(cell.querySelector("[style]")).toBeNull();
    }
  });

  it.each([true, false])("shows the configured resource status while enabled=%s", async (enabled) => {
    await load([{
      id: "e", name: "Engine", path: "engine.exe",
      options: { Threads: 4 }, resource: { groupId: "g", autoThreads: true },
    }], enabled);
    expect($("resourceStatus").textContent).toBe(
      text(enabled ? "editor.resourceStatusEnabled" : "editor.resourceStatusDisabled", "en"),
    );
    expect($("resourceStatus").closest("th")).toBe($("colResource").closest("th"));
    expect(document.querySelector("#engineTable tbody .resource-group")?.textContent).toBe("CPU");
    expect(document.querySelector("#engineTable tbody .resource-cost")?.textContent).toBe(
      text("editor.resourceCellAuto", "en", "4"),
    );
  });

  it("updates the resource status immediately when the setting changes", async () => {
    await load();
    $("resourceSettingsBtn").click();
    await vi.waitFor(() => expect($("resourceModal").style.display).toBe("block"));
    const checkbox = $<HTMLInputElement>("resourceEnabled");
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    expect($("resourceStatus").textContent).toBe(text("editor.resourceStatusDisabled", "en"));
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect($("resourceStatus").textContent).toBe(text("editor.resourceStatusEnabled", "en"));
    $("closeResourceModalBtn").click();
    expect($("resourceStatus").textContent).toBe(text("editor.resourceStatusEnabled", "en"));
    expect(api.editorSave).not.toHaveBeenCalled();
  });

  it("translates resource status and details without changing the Threads option name", async () => {
    await load([{
      id: "e", name: "Engine", path: "engine.exe",
      options: { Threads: 4 }, resource: { groupId: "g", autoThreads: true },
    }]);
    $<HTMLSelectElement>("langSelect").value = "ja";
    $("langSelect").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect($("resourceStatus").textContent).toBe("有効"));
    expect(document.querySelector("#engineTable tbody .resource-cost")?.textContent).toBe(
      text("editor.resourceCellAuto", "ja", "4"),
    );
    expect($("resourceSettingsBtn").textContent).toBe("リソース制限");
    document.querySelector<HTMLButtonElement>("#engineTable .btn-primary")!.click();
    expect($("resourceCostThreadsLabel").textContent).toBe("スレッド数に連動");
    expect(document.querySelector<HTMLInputElement>("#optionsList .opt-key")?.value).toBe("Threads");
  });

  it("refreshes the engine list resource details when the resource modal closes", async () => {
    await load([
      {
        id: "a",
        name: "A",
        path: "a.exe",
        options: { Threads: 4 },
        resource: { groupId: "g", autoThreads: true },
      },
    ]);
    $("resourceSettingsBtn").click();
    await vi.waitFor(() => expect($("resourceModal").style.display).toBe("block"));
    const nameInput = document.querySelector<HTMLInputElement>(
      "#resourceGroupTable tbody input",
    )!;
    nameInput.value = "Renamed";
    nameInput.dispatchEvent(new Event("input"));
    $("closeResourceModalBtn").click();
    expect(document.querySelector("#engineTable tbody td:nth-child(3)")!.textContent).toContain(
      "Renamed",
    );
  });

  it("seeds a default local CPU group so the first assignment needs no setup", async () => {
    vi.mocked(api.editorLoad).mockResolvedValue({ engines: [] });
    initEditor();
    await vi.waitFor(() =>
      expect($<HTMLButtonElement>("saveBtn").disabled).toBe(false),
    );
    $("addEngineBtn").click();
    const options = [...$<HTMLSelectElement>("editResourceGroupId").options];
    expect(options.map((o) => o.textContent)).toContain("Local CPU");
    $("saveBtn").click();
    await vi.waitFor(() => expect(api.editorSave).toHaveBeenCalledOnce());
    expect(vi.mocked(api.editorSave).mock.calls[0][1]).toMatchObject({
      groups: [{ id: "local-cpu", name: "Local CPU", budget: 8 }],
    });
  });

  it("asks for confirmation before deleting a group and clears its assignments", async () => {
    await load([
      {
        id: "e",
        name: "E",
        path: "engine.exe",
        options: { Threads: 2 },
        resource: { groupId: "g", autoThreads: true },
      },
    ]);
    $("resourceSettingsBtn").click();
    await vi.waitFor(() => expect($("resourceModal").style.display).toBe("block"));
    document
      .querySelector<HTMLButtonElement>("#resourceGroupTable .btn-danger")!
      .click();
    await vi.waitFor(() => expect(vi.mocked(confirmAction)).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(document.querySelector("#resourceGroupTable tbody tr")).toBeNull(),
    );
    $("closeResourceModalBtn").click();
    $("saveBtn").click();
    await vi.waitFor(() => expect(api.editorSave).toHaveBeenCalledOnce());
    expect(vi.mocked(api.editorSave).mock.calls[0][0][0].resource).toBeUndefined();
  });

  it("keeps the group when the deletion is declined", async () => {
    await load();
    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    $("resourceSettingsBtn").click();
    await vi.waitFor(() => expect($("resourceModal").style.display).toBe("block"));
    document
      .querySelector<HTMLButtonElement>("#resourceGroupTable .btn-danger")!
      .click();
    await vi.waitFor(() => expect(vi.mocked(confirmAction)).toHaveBeenCalledOnce());
    // Let the declined async handler settle, then verify nothing changed.
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelectorAll("#resourceGroupTable tbody tr")).toHaveLength(1);
    expect($("toastContainer").textContent).not.toContain(
      text("editor.groupDeleted", "en"),
    );
  });
});
