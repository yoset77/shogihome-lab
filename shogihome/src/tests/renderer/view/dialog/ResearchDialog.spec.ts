import { flushPromises, mount } from "@vue/test-utils";
import ResearchDialog from "@/renderer/view/dialog/ResearchDialog.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import { defaultResearchSettings } from "@/common/settings/research";
import { emptyUSIEngine, USIEngines } from "@/common/settings/usi";
import { t } from "@/common/i18n";
import { useBusyState } from "@/renderer/store/busy";

const mocks = vi.hoisted(() => ({
  loadResearchSettings: vi.fn(),
  loadUSIEngines: vi.fn(),
  startResearch: vi.fn(),
  closeResearchDialog: vi.fn(),
  destroyModalDialog: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/renderer/ipc/api", () => ({
  isNative: () => false,
  default: {
    loadResearchSettings: mocks.loadResearchSettings,
    loadUSIEngines: mocks.loadUSIEngines,
  },
}));
vi.mock("@/renderer/store", () => ({ useStore: () => mocks }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.error }) }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => ({ researchMultiPV: 1 }) }));
vi.mock("@/renderer/store/lan", () => ({
  useLanStore: () => ({
    status: { value: "connected" },
    engineList: { value: [{ id: "test", name: "Test engine" }] },
  }),
}));

describe("ResearchDialog MultiPV validation", () => {
  const wrappers: ReturnType<typeof mount>[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadResearchSettings.mockResolvedValue({
      ...defaultResearchSettings(),
      usi: { ...emptyUSIEngine(), uri: "lan-engine:test" },
      overrideMultiPV: true,
    });
    mocks.loadUSIEngines.mockResolvedValue(new USIEngines());
  });
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    expect(useBusyState().isBusy).toBe(false);
  });

  async function dialog() {
    const wrapper = mount(ResearchDialog, {
      global: {
        stubs: {
          DialogFrame: { template: "<div><slot /></div>" },
          PlayerSelector: true,
          Icon: true,
        },
      },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
  }

  it.each([1, 3, 10])(
    "starts with valid count %i and exposes the shared bounds",
    async (multiPV) => {
      const wrapper = await dialog();
      const input = wrapper.get("#research-multi-pv");
      expect(input.attributes()).toMatchObject({ min: "1", max: "10", step: "1" });
      await input.setValue(String(multiPV));
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.startResearch).toHaveBeenCalledWith(
        expect.objectContaining({ overrideMultiPV: true, multiPV }),
      );
      expect(mocks.error).not.toHaveBeenCalled();
    },
  );

  it.each(["", "0", "-1", "1.5", "11"])(
    "rejects invalid explicit count '%s' before starting",
    async (value) => {
      const wrapper = await dialog();
      await wrapper.get("#research-multi-pv").setValue(value);
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.startResearch).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith(new Error(t.multiPVInvalid(1, 10)));
    },
  );

  it("ignores an inactive invalid count without changing the saved value", async () => {
    const wrapper = await dialog();
    const input = wrapper.get<HTMLInputElement>("#research-multi-pv");
    await input.setValue("11");
    await wrapper.findAllComponents(ToggleButton)[1].get('input[type="checkbox"]').setValue(false);
    expect(input.element.disabled).toBe(true);
    expect(input.element.value).toBe("11");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.startResearch).toHaveBeenCalledWith(
      expect.objectContaining({ overrideMultiPV: false, multiPV: 11 }),
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
