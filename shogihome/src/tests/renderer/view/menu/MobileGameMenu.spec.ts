import { flushPromises, shallowMount } from "@vue/test-utils";
import MobileGameMenu from "@/renderer/view/menu/MobileGameMenu.vue";
import MobilePlayerSetting from "@/renderer/view/menu/MobilePlayerSetting.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import { defaultGameSettings } from "@/common/settings/game";
import { t } from "@/common/i18n";
import { Language } from "@/common/i18n/languages";
import { ref } from "vue";

const mocks = vi.hoisted(() => ({ start: vi.fn(), load: vi.fn(), save: vi.fn(), error: vi.fn() }));
vi.mock("@/renderer/store", () => ({
  useStore: () => ({ gameSettings: defaultGameSettings(), startGame: mocks.start }),
}));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => ({ language: Language.JA }) }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.error }) }));
vi.mock("@/renderer/store/lan", () => ({ useLanStore: () => ({ status: ref("connected") }) }));
vi.mock("@/renderer/helpers/dialog", () => ({ showModalDialog: vi.fn() }));
vi.mock("@/renderer/devices/hotkey", () => ({
  installHotKeyForDialog: vi.fn(),
  uninstallHotKeyForDialog: vi.fn(),
}));
vi.mock("@/renderer/ipc/api", () => ({
  default: {
    loadGameSettings: mocks.load,
    saveGameSettings: mocks.save,
    listServerPosition: async () => [],
    listServerBook: async () => [],
  },
}));

describe("mobile game background start", () => {
  const backgroundItem = (wrapper: ReturnType<typeof shallowMount>) =>
    wrapper.findAll(".form-item").find((item) => item.text().includes(t.jobsBackground));

  beforeEach(() => {
    vi.clearAllMocks();
    const settings = defaultGameSettings();
    settings.black = { uri: "lan-engine:black", name: "Black" };
    settings.white = { uri: "lan-engine:white", name: "White" };
    settings.enableAutoSave = false;
    mocks.load.mockResolvedValue(settings);
    mocks.save.mockResolvedValue(undefined);
  });

  it("starts engine games in the background only when explicitly selected", async () => {
    const wrapper = shallowMount(MobileGameMenu);
    await flushPromises();
    backgroundItem(wrapper)!.findComponent(ToggleButton).vm.$emit("update:value", true);
    await wrapper.find("button.start").trigger("click");
    await flushPromises();
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ black: expect.objectContaining({ uri: "lan-engine:black" }) }),
      true,
    );
    expect(mocks.error).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("hides and ignores background selection when a human participates", async () => {
    const wrapper = shallowMount(MobileGameMenu);
    await flushPromises();
    backgroundItem(wrapper)!.findComponent(ToggleButton).vm.$emit("update:value", true);
    wrapper.findAllComponents(MobilePlayerSetting)[0].vm.$emit("update:playerUri", "es://human");
    await flushPromises();
    expect(backgroundItem(wrapper)).toBeUndefined();
    await wrapper.find("button.start").trigger("click");
    await flushPromises();
    expect(mocks.start).toHaveBeenCalledWith(expect.anything(), false);
    wrapper.unmount();
  });
  it("forces parallel games into the background and resets parallelism for human games", async () => {
    const wrapper = shallowMount(MobileGameMenu);
    await flushPromises();
    await wrapper.get("#mobile-game-parallelism").setValue("4");
    expect(wrapper.text()).toContain(t.parallelGameNote);
    expect(backgroundItem(wrapper)).toBeUndefined();
    await wrapper.find("button.start").trigger("click");
    await flushPromises();
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ parallelism: 4 }), true);
    wrapper.findAllComponents(MobilePlayerSetting)[0].vm.$emit("update:playerUri", "es://human");
    await flushPromises();
    await wrapper.find("button.start").trigger("click");
    await flushPromises();
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ parallelism: 1 }),
      false,
    );
    wrapper.unmount();
  });
});
