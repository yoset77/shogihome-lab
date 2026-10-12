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
}));

vi.mock("@/renderer/ipc/api", () => ({
  isNative: () => false,
  default: {
    loadAnalysisSettings: mocks.loadAnalysisSettings,
    loadUSIEngines: mocks.loadUSIEngines,
  },
}));
vi.mock("@/renderer/store", () => ({ useStore: () => mocks }));
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
