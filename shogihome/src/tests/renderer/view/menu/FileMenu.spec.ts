import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { AppState, ResearchState } from "@/common/control/state";
import { t } from "@/common/i18n";
import FileMenu from "@/renderer/view/menu/FileMenu.vue";

const { useStore, isMobileWebApp } = vi.hoisted(() => ({
  useStore: vi.fn(),
  isMobileWebApp: vi.fn(() => true),
}));

vi.mock("@/renderer/store", () => ({ useStore }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => ({}) }));
vi.mock("@/renderer/store/lan", () => ({ useLanStore: () => ({}) }));
vi.mock("@/renderer/ipc/api", () => ({
  default: {},
  appInfo: {},
  isMobileWebApp,
  isNative: () => false,
}));
vi.mock("@/renderer/helpers/dialog", () => ({ showModalDialog: vi.fn() }));
vi.mock("@/renderer/devices/hotkey", () => ({
  installHotKeyForDialog: vi.fn(),
  uninstallHotKeyForDialog: vi.fn(),
}));
vi.mock("@/renderer/helpers/copyright", () => ({ openCopyright: vi.fn() }));

const store = reactive({
  appState: AppState.NORMAL,
  researchState: ResearchState.IDLE,
  stopMateSearch: vi.fn(),
});
const mountMenu = () => shallowMount(FileMenu);
const findStopButton = (wrapper: ReturnType<typeof mountMenu>) =>
  wrapper.findAll("button").find((button) => button.text() === t.stopMateSearch);

enableAutoUnmount(afterEach);

describe("FileMenu mate search", () => {
  beforeEach(() => {
    store.appState = AppState.NORMAL;
    store.researchState = ResearchState.IDLE;
    store.stopMateSearch.mockReset();
    isMobileWebApp.mockReturnValue(true);
    useStore.mockReturnValue(store);
  });

  it("stops an active mate search and closes the mobile menu", async () => {
    store.appState = AppState.MATE_SEARCH;
    const wrapper = mountMenu();
    const button = findStopButton(wrapper);

    expect(button).toBeDefined();
    await button!.trigger("click");

    expect(store.stopMateSearch).toHaveBeenCalledOnce();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it.each([AppState.NORMAL, AppState.MATE_SEARCH_DIALOG, AppState.GAME, AppState.ANALYSIS])(
    "does not show the stop button in %s",
    (appState) => {
      store.appState = appState;
      expect(findStopButton(mountMenu())).toBeUndefined();
    },
  );

  it("does not add the mobile stop button to the PC menu", () => {
    store.appState = AppState.MATE_SEARCH;
    isMobileWebApp.mockReturnValue(false);
    expect(findStopButton(mountMenu())).toBeUndefined();
  });

  it("hides the stop button when the search finishes while the menu is open", async () => {
    store.appState = AppState.MATE_SEARCH;
    const wrapper = mountMenu();
    expect(findStopButton(wrapper)).toBeDefined();

    store.appState = AppState.NORMAL;
    await nextTick();

    expect(findStopButton(wrapper)).toBeUndefined();
    expect(store.stopMateSearch).not.toHaveBeenCalled();
  });
});
