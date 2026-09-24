import { shallowMount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppState } from "@/common/control/state";
import { t } from "@/common/i18n";
import { FileQuickAction } from "@/common/settings/app";
import ControlPane, { ControlGroup } from "@/renderer/view/main/ControlPane.vue";
import FileMenu from "@/renderer/view/menu/FileMenu.vue";

const { storeMock, settingsMock, isNativeMock, isMobileWebAppMock } = vi.hoisted(() => ({
  storeMock: {
    appState: "normal",
    isServerSideKifuEnabled: true,
    startPuzzle: vi.fn(),
    openRecord: vi.fn(),
    showServerKifuDialog: vi.fn(),
    showRecordFileHistoryDialog: vi.fn(),
    showElapsedTimeChartDialog: vi.fn(),
  },
  settingsMock: { fileQuickAction: "puzzle" },
  isNativeMock: vi.fn(() => false),
  isMobileWebAppMock: vi.fn(() => false),
}));

const store = reactive(storeMock);
const settings = reactive(settingsMock);
vi.mock("@/renderer/store", () => ({ useStore: () => store }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => settings }));
vi.mock("@/renderer/store/lan", () => ({ useLanStore: () => ({}) }));
vi.mock("@/renderer/ipc/api", () => ({
  default: {},
  isNative: isNativeMock,
  isMobileWebApp: isMobileWebAppMock,
}));
vi.mock("@/renderer/helpers/dialog", () => ({ showModalDialog: vi.fn() }));
vi.mock("@/renderer/devices/hotkey", () => ({
  installHotKeyForDialog: vi.fn(),
  uninstallHotKeyForDialog: vi.fn(),
  installHotKeyForMainWindow: vi.fn(),
  uninstallHotKeyForMainWindow: vi.fn(),
}));

describe("PC file quick action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.appState = AppState.NORMAL;
    store.isServerSideKifuEnabled = true;
    settings.fileQuickAction = FileQuickAction.PUZZLE;
    isMobileWebAppMock.mockReturnValue(false);
    isNativeMock.mockReturnValue(false);
  });

  it("changes the button and grays out an unavailable server action", async () => {
    const wrapper = shallowMount(ControlPane, { props: { group: ControlGroup.Group2 } });
    const quickButton = wrapper.findAll("button")[3];

    expect(quickButton.text()).toBe(t.puzzles);
    settings.fileQuickAction = FileQuickAction.LOAD_FROM_SERVER;
    await nextTick();
    expect(quickButton.text()).toBe(t.loadFromServer);
    await quickButton.trigger("click");
    expect(store.showServerKifuDialog).toHaveBeenCalledOnce();

    store.isServerSideKifuEnabled = false;
    await nextTick();
    expect(quickButton.attributes("disabled")).toBeDefined();
    store.appState = AppState.ANALYSIS;
    settings.fileQuickAction = FileQuickAction.HISTORY;
    await nextTick();
    expect(quickButton.text()).toBe(t.history);
    expect(quickButton.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("keeps puzzle accessible from the PC file menu", async () => {
    settings.fileQuickAction = FileQuickAction.HISTORY;
    const wrapper = shallowMount(FileMenu);
    const puzzleButton = wrapper.findAll("button").find((button) => button.text() === t.puzzles);
    const historyButton = wrapper.findAll("button").find((button) => button.text() === t.history);

    expect(puzzleButton).toBeDefined();
    expect(puzzleButton!.element.closest(".group")).toBe(historyButton!.element.closest(".group"));
    await puzzleButton!.trigger("click");
    expect(store.startPuzzle).toHaveBeenCalledOnce();
    expect(wrapper.emitted("close")).toHaveLength(1);

    store.appState = AppState.GAME;
    await nextTick();
    expect(puzzleButton!.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("shows server opening disabled on PC without KIFU_DIR and enables it when available", async () => {
    store.isServerSideKifuEnabled = false;
    const wrapper = shallowMount(FileMenu);
    const serverButton = wrapper
      .findAll("button")
      .find((button) => button.text() === t.loadFromServer);

    expect(serverButton).toBeDefined();
    expect(serverButton!.attributes("disabled")).toBeDefined();

    store.isServerSideKifuEnabled = true;
    await nextTick();
    expect(serverButton!.attributes("disabled")).toBeUndefined();
    await serverButton!.trigger("click");
    expect(store.showServerKifuDialog).toHaveBeenCalledOnce();
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("keeps the server menu item hidden on mobile without KIFU_DIR", () => {
    isMobileWebAppMock.mockReturnValue(true);
    store.isServerSideKifuEnabled = false;
    const wrapper = shallowMount(FileMenu);

    expect(wrapper.findAll("button").some((button) => button.text() === t.loadFromServer)).toBe(
      false,
    );
    wrapper.unmount();
  });
});
