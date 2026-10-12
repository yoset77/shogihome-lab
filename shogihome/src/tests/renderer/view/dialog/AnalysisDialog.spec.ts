import { flushPromises, mount } from "@vue/test-utils";
import AnalysisDialog from "@/renderer/view/dialog/AnalysisDialog.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import { defaultAnalysisSettings, normalizeAnalysisSettings } from "@/common/settings/analysis";
import { emptyUSIEngine, USIEngines } from "@/common/settings/usi";
import { t } from "@/common/i18n";
import { useBusyState } from "@/renderer/store/busy";

const mocks = vi.hoisted(() => ({
  loadAnalysisSettings: vi.fn(),
  loadUSIEngines: vi.fn(),
  startAnalysis: vi.fn(),
  closeModalDialog: vi.fn(),
  destroyModalDialog: vi.fn(),
  error: vi.fn(),
  prepareBatch: vi.fn(),
  startBatchAnalysis: vi.fn(),
  confirm: vi.fn(),
  analysisSource: undefined as
    | { kind: "folder"; directory: string; subdirectories: boolean }
    | { kind: "search"; search: { player1?: string } }
    | undefined,
}));

vi.mock("@/renderer/ipc/api", () => ({
  isNative: () => false,
  default: {
    loadAnalysisSettings: mocks.loadAnalysisSettings,
    loadUSIEngines: mocks.loadUSIEngines,
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
    mocks.prepareBatch.mockResolvedValue({
      planId: "plan",
      files: ["a.kifu", "b.jkf"],
      expiresAt: Date.now() + 600_000,
    });
    mocks.loadAnalysisSettings.mockResolvedValue({
      ...defaultAnalysisSettings(),
      usi: { ...emptyUSIEngine(), uri: "lan-engine:test" },
    });
    mocks.loadUSIEngines.mockResolvedValue(new USIEngines());
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
          HorizontalSelector: true,
        },
      },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
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

  it("confirms a server folder without a format selection UI before starting", async () => {
    mocks.analysisSource = { kind: "folder", directory: "games", subdirectories: true };
    const wrapper = await dialog();
    expect(wrapper.get<HTMLInputElement>("#batch-directory").element.value).toBe("games");
    expect(wrapper.text()).not.toContain(".ki2");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.prepareBatch).toHaveBeenCalledWith({
      kind: "folder",
      directory: "games",
      subdirectories: true,
    });
    expect(mocks.startBatchAnalysis).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("a.kifu");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: t.batchAnalysisConfirm(2) }),
    );
    mocks.confirm.mock.calls[0][0].onOk();
    expect(mocks.startBatchAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "games", skipAnalyzed: true }),
      expect.objectContaining({ overrideMultiPV: false }),
      expect.objectContaining({ planId: "plan" }),
      false,
    );
  });

  it("passes the executed search rather than displayed paths", async () => {
    mocks.analysisSource = { kind: "search", search: { player1: "Test" } };
    const wrapper = await dialog();
    expect(wrapper.find("#batch-directory").exists()).toBe(false);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.prepareBatch).toHaveBeenCalledWith({
      kind: "search",
      search: { player1: "Test" },
    });
  });

  it("invalidates the confirmed list after changing its folder", async () => {
    mocks.analysisSource = { kind: "folder", directory: "games", subdirectories: true };
    const wrapper = await dialog();
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    await wrapper.get("#batch-directory").setValue("other");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    await flushPromises();
    expect(mocks.prepareBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ directory: "other" }),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("retains the count when toggled off and on and passes it to background analysis", async () => {
    const wrapper = await dialog();
    const toggle = wrapper.findAllComponents(ToggleButton)[0].get('input[type="checkbox"]');
    const input = wrapper.get<HTMLInputElement>("#analysis-multi-pv");
    await toggle.setValue(true);
    await input.setValue("3");
    await toggle.setValue(false);
    expect(input.element.disabled).toBe(true);
    expect(input.element.value).toBe("3");
    await toggle.setValue(true);
    await wrapper
      .findAllComponents(ToggleButton)
      .at(-1)!
      .get('input[type="checkbox"]')
      .setValue(true);
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
      await wrapper.findAllComponents(ToggleButton)[0].get('input[type="checkbox"]').setValue(true);
      await wrapper.get("#analysis-multi-pv").setValue(value);
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.startAnalysis).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith(new Error(t.multiPVInvalid(1, 10)));
    },
  );
});
