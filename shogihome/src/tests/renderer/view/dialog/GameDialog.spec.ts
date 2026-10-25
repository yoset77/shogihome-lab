import { flushPromises, shallowMount } from "@vue/test-utils";
import { ref } from "vue";
import GameDialog from "@/renderer/view/dialog/GameDialog.vue";
import PlayerSelector from "@/renderer/view/dialog/PlayerSelector.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import { defaultGameSettings } from "@/common/settings/game";
import { t } from "@/common/i18n";
import { Language } from "@/common/i18n/languages";

const mocks = vi.hoisted(() => ({ start: vi.fn(), load: vi.fn(), error: vi.fn() }));
vi.mock("@/renderer/store", () => ({ useStore: () => ({ startGame: mocks.start }) }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.error }) }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => ({ language: Language.JA }) }));
vi.mock("@/renderer/store/lan", () => ({
  useLanStore: () => ({ status: ref("connected"), engineList: ref([]) }),
}));
vi.mock("@/renderer/ipc/api", () => ({
  default: {
    loadGameSettings: mocks.load,
    listServerPosition: async () => [],
    listServerBook: async () => [],
  },
}));

describe("parallel game settings dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockResolvedValue({
      ...defaultGameSettings(),
      repeat: 4,
      black: { uri: "lan-engine:black", name: "Black" },
      white: { uri: "lan-engine:white", name: "White" },
    });
  });
  const mountDialog = () =>
    shallowMount(GameDialog, {
      global: { stubs: { DialogFrame: { template: "<div><slot /></div>" } } },
    });
  const background = (wrapper: ReturnType<typeof mountDialog>) =>
    wrapper
      .findAllComponents(ToggleButton)
      .find((toggle) => toggle.props("label") === t.jobsBackground);
  it("defaults to serial and forces parallel games into the background", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#game-parallelism").element.value).toBe("1");
    expect(background(wrapper)).toBeDefined();
    await wrapper.get("#game-parallelism").setValue("4");
    expect(background(wrapper)).toBeUndefined();
    expect(wrapper.text()).toContain(t.parallelGameNote);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ parallelism: 4 }), true);
    await wrapper.get("#game-parallelism").setValue("1");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ parallelism: 1 }),
      false,
    );
    wrapper.unmount();
  });
  it("does not reuse saved parallelism when a player is human", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.get("#game-parallelism").setValue("4");
    wrapper.findAllComponents(PlayerSelector)[0].vm.$emit("update:playerUri", "es://human");
    await flushPromises();
    expect(wrapper.find("#game-parallelism").exists()).toBe(false);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    // Human games must also use one repeat, independently of parallelism.
    expect(mocks.error).toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it.each(["", "0", "1.5", "17"])("rejects invalid parallelism '%s'", async (value) => {
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.get("#game-parallelism").setValue(value);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.error).toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
