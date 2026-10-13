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
import { initEditor } from "./editor";

vi.mock("./api", () => ({
  api: {
    getUiLanguage: vi.fn(async () => "en"),
    editorLoad: vi.fn(),
    editorSave: vi.fn(async () => {}),
    resourceCores: vi.fn(async () => 8),
    editorProbe: vi.fn(async () => {
      throw new Error("No engine in DOM tests");
    }),
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

  async function load(engines: EngineEntry[] = []) {
    vi.mocked(api.editorLoad).mockResolvedValue({
      engines,
      resources: structuredClone(resources),
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

  it("defaults a newly entered script to manual before and after group assignment", async () => {
    await load();
    $("addEngineBtn").click();
    $<HTMLInputElement>("editName").value = "Script";
    changePath("engine.sh");
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
    assign();
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
    expect((await saveEngine()).resource).toEqual({
      groupId: "g",
      autoThreads: false,
      cost: 1,
    });
  });

  it("keeps an unassigned existing script's manual default", async () => {
    await load([{ id: "script", name: "Script", path: "engine.cmd" }]);
    document
      .querySelector<HTMLButtonElement>("#engineTable .btn-primary")!
      .click();
    expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true);
    assign();
    expect((await saveEngine()).resource?.autoThreads).toBe(false);
  });

  it("defaults a browsed script to manual", async () => {
    await load();
    $("addEngineBtn").click();
    vi.mocked(api.editorBrowse).mockResolvedValue("engine.ps1");
    $("browseBtn").click();
    await vi.waitFor(() =>
      expect($<HTMLInputElement>("resourceCostManual").checked).toBe(true),
    );
  });

  it("preserves an explicit Threads choice across path and group changes", async () => {
    await load([
      {
        id: "script",
        name: "Script",
        path: "engine.sh",
        resource: { groupId: "g", autoThreads: true },
      },
    ]);
    document
      .querySelector<HTMLButtonElement>("#engineTable .btn-primary")!
      .click();
    changePath("other.cmd");
    $<HTMLSelectElement>("editResourceGroupId").value = "";
    $("editResourceGroupId").dispatchEvent(new Event("change"));
    assign();
    expect($<HTMLInputElement>("resourceCostThreads").checked).toBe(true);
    expect((await saveEngine()).resource?.autoThreads).toBe(true);
  });

  it("allows a new script to explicitly choose Threads without later path changes undoing it", async () => {
    await load();
    $("addEngineBtn").click();
    $<HTMLInputElement>("editName").value = "Script";
    changePath("engine.sh");
    assign();
    $("resourceCostThreads").click();
    changePath("another.sh");
    expect((await saveEngine()).resource?.autoThreads).toBe(true);
  });

  it("allows a normal executable to explicitly choose a manual cost", async () => {
    await load();
    $("addEngineBtn").click();
    $<HTMLInputElement>("editName").value = "Engine";
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
});
