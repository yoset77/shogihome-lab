import { flushPromises, mount } from "@vue/test-utils";
import AnalysisDialog from "@/renderer/view/dialog/AnalysisDialog.vue";
import { defaultAnalysisSettings, normalizeAnalysisSettings } from "@/common/settings/analysis";
import { emptyUSIEngine } from "@/common/settings/usi";
import { t } from "@/common/i18n";
import { useBusyState } from "@/renderer/store/busy";

const mocks = vi.hoisted(() => ({
  loadAnalysisSettings: vi.fn(),
  startAnalysis: vi.fn(),
  closeModalDialog: vi.fn(),
  destroyModalDialog: vi.fn(),
  error: vi.fn(),
  prepareBatch: vi.fn(),
  startBatchAnalysis: vi.fn(),
  confirm: vi.fn(),
  listServerDirectories: vi.fn(),
  analysisSource: undefined as
    | { kind: "folder"; directory: string; subdirectories: boolean }
    | { kind: "search"; search: { player1?: string } }
    | undefined,
}));

vi.mock("@/renderer/ipc/api", () => ({
  default: {
    loadAnalysisSettings: mocks.loadAnalysisSettings,
    listServerDirectories: mocks.listServerDirectories,
  },
}));
vi.mock("@/renderer/store", () => ({ useStore: () => mocks }));
vi.mock("@/renderer/store/confirm", () => ({
  useConfirmationStore: () => ({ show: mocks.confirm }),
}));
vi.mock("@/renderer/store/batch_analysis", async (original) => ({
  ...(await original<typeof import("@/renderer/store/batch_analysis")>()),
  prepareBatchAnalysis: mocks.prepareBatch,
}));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.error }) }));
vi.mock("@/renderer/store/lan", () => ({
  useLanStore: () => ({
    status: { value: "connected" },
    engineList: { value: [{ id: "test", name: "Test engine" }] },
  }),
}));

describe("AnalysisDialog MultiPV", () => {
  const wrappers: ReturnType<typeof mount>[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.analysisSource = undefined;
    mocks.listServerDirectories.mockResolvedValue({ path: "", directories: [] });
    mocks.prepareBatch.mockResolvedValue({
      planId: "plan",
      files: ["a.kifu", "b.jkf"],
      expiresAt: Date.now() + 600_000,
    });
    mocks.loadAnalysisSettings.mockResolvedValue({
      ...defaultAnalysisSettings(),
      usi: { ...emptyUSIEngine(), uri: "lan-engine:test" },
    });
  });
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    expect(useBusyState().isBusy).toBe(false);
  });

  async function dialog() {
    const wrapper = mount(AnalysisDialog, {
      global: {
        stubs: {
          DialogFrame: { template: "<div><slot /></div>" },
          PlayerSelector: true,
        },
      },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
  }

  function selectTarget(wrapper: ReturnType<typeof mount>, value: "record" | "folder" | "search") {
    const radio = wrapper
      .findAll('input[type="radio"]')
      .find((radio) => (radio.element as HTMLInputElement).value === value);
    if (!radio) {
      throw new Error(`target radio not found: ${value}`);
    }
    return radio.setValue();
  }

  async function chooseGamesFolder(wrapper: ReturnType<typeof mount>) {
    mocks.listServerDirectories.mockImplementation(async (path: string) => ({
      path,
      directories: [{ name: "games", path: "games" }],
    }));
    await wrapper.get(".path-input button").trigger("click");
    await flushPromises();
    await wrapper
      .findAll(".server-selection-item")
      .find((item) => item.text().includes("games"))!
      .get("button")
      .trigger("click");
  }

  function skipToggle(wrapper: ReturnType<typeof mount>) {
    return wrapper
      .findAll(".form-item.row")
      .find((row) => row.text().includes(t.skipAnalyzed))!
      .get('input[type="checkbox"]');
  }

  function multiPVToggle(wrapper: ReturnType<typeof mount>) {
    return wrapper.get('div[data-test="override-multi-pv"] input[type="checkbox"]');
  }

  it("starts with engine-controlled MultiPV and restores legacy settings", async () => {
    mocks.loadAnalysisSettings.mockResolvedValue(
      normalizeAnalysisSettings({ usi: { ...emptyUSIEngine(), uri: "lan-engine:test" } }),
    );
    const wrapper = await dialog();
    const input = wrapper.get<HTMLInputElement>("#analysis-multi-pv");
    expect(input.element.disabled).toBe(true);
    expect(input.element.value).toBe("1");
    expect(input.attributes()).toMatchObject({ min: "1", max: "10", step: "1" });
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ overrideMultiPV: false, multiPV: 1 }),
      false,
    );
  });

  it("confirms a server folder with the picker and starts batch analysis", async () => {
    mocks.listServerDirectories.mockImplementation(async (path: string) => ({
      path,
      directories: [{ name: "games", path: "games" }],
    }));
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    await wrapper.get(".path-input button").trigger("click");
    await flushPromises();
    expect(mocks.listServerDirectories).toHaveBeenCalledWith("");
    expect(wrapper.text()).not.toContain(".ki2");
    const row = wrapper
      .findAll(".server-selection-item")
      .find((item) => item.text().includes("games"));
    await row!.get("button").trigger("click");
    expect(wrapper.get<HTMLInputElement>(".path-input input").element.value).toBe("server://games");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.prepareBatch).toHaveBeenCalledWith({
      kind: "folder",
      directory: "games",
      subdirectories: true,
    });
    expect(mocks.startBatchAnalysis).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("a.kifu");
    mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.startBatchAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "games", skipAnalyzed: true }),
      expect.objectContaining({ overrideMultiPV: false }),
      expect.objectContaining({ planId: "plan" }),
      false,
    );
  });

  it("requires a folder selection before starting batch analysis", async () => {
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.error).toHaveBeenCalledWith(t.batchAnalysisInvalid);
    expect(mocks.prepareBatch).not.toHaveBeenCalled();
  });
  it("forces parallel batch analysis into the background without adding another viewer", async () => {
    mocks.analysisSource = { kind: "search", search: { player1: "Test" } };
    const wrapper = await dialog();
    const input = wrapper.get<HTMLInputElement>("#batch-analysis-parallelism");
    expect(input.element.value).toBe("1");
    expect(input.attributes()).toMatchObject({ min: "1", max: "16", step: "1" });
    await input.setValue("4");
    const toggle = wrapper.get<HTMLInputElement>(
      'div[data-test="background"] input[type="checkbox"]',
    );
    expect(toggle.attributes("disabled")).toBeDefined();
    expect(toggle.element.checked).toBe(true);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.startBatchAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ parallelism: 4 }),
      expect.anything(),
      expect.objectContaining({ planId: "plan" }),
      true,
    );
    await selectTarget(wrapper, "record");
    expect(wrapper.find('div[data-test="background"]').exists()).toBe(true);
    expect(toggle.attributes("disabled")).toBeUndefined();
    expect(toggle.element.checked).toBe(false);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.startAnalysis).toHaveBeenCalledWith(expect.anything(), false);
  });
  it("restores parallel batch settings and retains foreground support at parallelism one", async () => {
    localStorage.setItem("shogihome-batch-analysis-settings", JSON.stringify({ parallelism: 3 }));
    mocks.analysisSource = { kind: "search", search: {} };
    const wrapper = await dialog();
    const input = wrapper.get<HTMLInputElement>("#batch-analysis-parallelism");
    expect(input.element.value).toBe("3");
    const toggle = wrapper.get<HTMLInputElement>(
      'div[data-test="background"] input[type="checkbox"]',
    );
    expect(toggle.attributes("disabled")).toBeDefined();
    expect(toggle.element.checked).toBe(true);
    await input.setValue("1");
    expect(wrapper.find('div[data-test="background"]').exists()).toBe(true);
    expect(toggle.attributes("disabled")).toBeUndefined();
    expect(toggle.element.checked).toBe(false);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.startBatchAnalysis.mock.calls[0][3]).toBe(false);
  });
  it.each(["", "0", "-1", "1.5", "17"])(
    "rejects invalid parallelism '%s' before checking targets",
    async (value) => {
      mocks.analysisSource = { kind: "search", search: {} };
      const wrapper = await dialog();
      await wrapper.get("#batch-analysis-parallelism").setValue(value);
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.error).toHaveBeenCalledWith(t.batchAnalysisInvalid);
      expect(mocks.prepareBatch).not.toHaveBeenCalled();
      expect(mocks.startBatchAnalysis).not.toHaveBeenCalled();
    },
  );

  it("lists target files on demand without starting batch analysis", async () => {
    mocks.listServerDirectories.mockImplementation(async (path: string) => ({
      path,
      directories: [{ name: "games", path: "games" }],
    }));
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    await chooseGamesFolder(wrapper);
    expect(wrapper.text()).not.toContain("a.kifu");
    await wrapper.get('button[data-test="check-targets"]').trigger("click");
    await flushPromises();
    expect(mocks.prepareBatch).toHaveBeenCalledWith({
      kind: "folder",
      directory: "games",
      subdirectories: true,
    });
    expect(wrapper.text()).toContain("a.kifu");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.startBatchAnalysis).not.toHaveBeenCalled();
  });

  it("disables the target check until a folder is selected", async () => {
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    expect(
      wrapper.get<HTMLButtonElement>('button[data-test="check-targets"]').element.disabled,
    ).toBe(true);
    await chooseGamesFolder(wrapper);
    expect(
      wrapper.get<HTMLButtonElement>('button[data-test="check-targets"]').element.disabled,
    ).toBe(false);
  });

  it("explains the skip count only while skipping analyzed records", async () => {
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    expect(wrapper.text()).toContain(t.batchAnalysisSkipNote);
    await skipToggle(wrapper).setValue(false);
    expect(wrapper.text()).not.toContain(t.batchAnalysisSkipNote);
  });

  it("confirms an upper bound of files while skipping analyzed records", async () => {
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    await chooseGamesFolder(wrapper);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.confirm.mock.calls[0][0].message).toBe(t.batchAnalysisConfirm(2));
  });

  it("confirms an upper bound of files when not skipping analyzed records", async () => {
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    await chooseGamesFolder(wrapper);
    await skipToggle(wrapper).setValue(false);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.confirm.mock.calls[0][0].message).toBe(t.batchAnalysisConfirm(2));
  });

  it("discards the confirmed list when the target changes", async () => {
    mocks.analysisSource = { kind: "search", search: { player1: "Test" } };
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    await chooseGamesFolder(wrapper);
    await wrapper.get('button[data-test="check-targets"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("a.kifu");
    await selectTarget(wrapper, "search");
    expect(wrapper.text()).not.toContain("a.kifu");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.prepareBatch).toHaveBeenLastCalledWith({
      kind: "search",
      search: { player1: "Test" },
    });
  });

  it("confirms the root folder as the analysis target", async () => {
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    await wrapper.get(".path-input button").trigger("click");
    await flushPromises();
    await wrapper
      .findAll(".server-selection-item")
      .find((item) => item.text().includes("Root"))!
      .get("button")
      .trigger("click");
    expect(wrapper.get<HTMLInputElement>(".path-input input").element.value).toBe("server://");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.prepareBatch).toHaveBeenCalledWith({
      kind: "folder",
      directory: "",
      subdirectories: true,
    });
  });

  it("passes the executed search rather than displayed paths", async () => {
    mocks.analysisSource = { kind: "search", search: { player1: "Test" } };
    const wrapper = await dialog();
    expect(wrapper.find(".server-selection-list").exists()).toBe(false);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.prepareBatch).toHaveBeenCalledWith({
      kind: "search",
      search: { player1: "Test" },
    });
  });

  it("offers the search target only when opened from search results", async () => {
    const wrapper = await dialog();
    const values = wrapper
      .findAll('input[type="radio"]')
      .map((radio) => (radio.element as HTMLInputElement).value);
    expect(values).not.toContain("search");
  });

  it("invalidates the confirmed list after changing its folder", async () => {
    mocks.listServerDirectories.mockImplementation(async (path: string) => ({
      path,
      directories: [
        { name: "games", path: "games" },
        { name: "other", path: "other" },
      ],
    }));
    const wrapper = await dialog();
    await selectTarget(wrapper, "folder");
    await wrapper.get(".path-input button").trigger("click");
    await flushPromises();
    await wrapper
      .findAll(".server-selection-item")
      .find((item) => item.text().includes("games"))!
      .get("button")
      .trigger("click");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    await wrapper.get(".path-input button").trigger("click");
    await flushPromises();
    expect(mocks.listServerDirectories).toHaveBeenLastCalledWith("games");
    await wrapper
      .findAll(".server-selection-item")
      .find((item) => item.text().includes("other"))!
      .get("button")
      .trigger("click");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.prepareBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ directory: "other" }),
    );
  });

  it("retains the count when toggled off and on and passes it to background analysis", async () => {
    const wrapper = await dialog();
    const input = wrapper.get<HTMLInputElement>("#analysis-multi-pv");
    await multiPVToggle(wrapper).setValue(true);
    await input.setValue("3");
    await multiPVToggle(wrapper).setValue(false);
    expect(input.element.disabled).toBe(true);
    expect(input.element.value).toBe("3");
    await multiPVToggle(wrapper).setValue(true);
    await wrapper.get('div[data-test="background"] input[type="checkbox"]').setValue(true);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ overrideMultiPV: true, multiPV: 3 }),
      true,
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("restores the saved override and count", async () => {
    mocks.loadAnalysisSettings.mockResolvedValue({
      ...defaultAnalysisSettings(),
      usi: { ...emptyUSIEngine(), uri: "lan-engine:test" },
      overrideMultiPV: true,
      multiPV: 5,
    });
    const wrapper = await dialog();
    const input = wrapper.get<HTMLInputElement>("#analysis-multi-pv");
    expect(input.element.disabled).toBe(false);
    expect(input.element.value).toBe("5");
  });

  it.each(["", "0", "-1", "1.5", "11"])(
    "rejects invalid explicit count '%s' before starting",
    async (value) => {
      const wrapper = await dialog();
      await multiPVToggle(wrapper).setValue(true);
      await wrapper.get("#analysis-multi-pv").setValue(value);
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.startAnalysis).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith(new Error(t.multiPVInvalid(1, 10)));
    },
  );
});
