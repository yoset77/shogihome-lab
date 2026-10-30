import { enableAutoUnmount, flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { AppState, ResearchState } from "@/common/control/state";
import { t } from "@/common/i18n";
import FileMenu from "@/renderer/view/menu/FileMenu.vue";
import MobileGameMenu from "@/renderer/view/menu/MobileGameMenu.vue";
import { useFileSaveStore } from "@/renderer/store/fileSave";
import { Record } from "tsshogi";

const { useStore, isMobileWebApp, pwaUpdate } = vi.hoisted(() => ({
  useStore: vi.fn(),
  isMobileWebApp: vi.fn(() => true),
  pwaUpdate: { available: false, show: vi.fn() },
}));

vi.mock("@/renderer/store", () => ({ useStore }));
vi.mock("@/renderer/store/pwa", () => ({ usePwaUpdateStore: () => pwaUpdate }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => ({}) }));
vi.mock("@/renderer/store/lan", () => ({ useLanStore: () => ({}) }));
vi.mock("@/renderer/ipc/api", () => ({
  default: {},
  appInfo: {},
  isMobileWebApp,
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
  isAnalysisCancelling: false,
  hasRetainedGame: false,
  hasGameRecoveryCandidate: false,
  hasRetainedAnalysis: true,
  gameReconnecting: true,
  gamePaused: true,
  showAnalysisDialog: vi.fn(),
  stopAnalysis: vi.fn(),
  showGameDialog: vi.fn(),
  saveRecord: vi.fn(),
  record: new Record(),
  isServerSideKifuEnabled: true,
  serverKifuPath: "games/current.jkf",
  recordFilePath: undefined,
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
    store.stopAnalysis.mockReset();
    store.showAnalysisDialog.mockReset();
    store.showGameDialog.mockReset();
    store.saveRecord.mockReset();
    useFileSaveStore().finish();
    store.isAnalysisCancelling = false;
    store.hasRetainedGame = false;
    store.hasGameRecoveryCandidate = false;
    pwaUpdate.available = false;
    pwaUpdate.show.mockReset();
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

  it("starts or recovers record analysis from the same mobile action", async () => {
    const wrapper = mountMenu();
    const button = wrapper.findAll("button").find((button) => button.text() === t.recordAnalysis);
    expect(button).toBeDefined();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    await button!.trigger("click");
    expect(store.showAnalysisDialog).toHaveBeenCalledOnce();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("stops analysis and prevents duplicate cancellation while awaiting confirmation", async () => {
    store.appState = AppState.ANALYSIS;
    const wrapper = mountMenu();
    const button = wrapper.findAll("button").find((button) => button.text() === t.stopAnalysis)!;
    expect(button).toBeDefined();
    await button.trigger("click");
    expect(store.stopAnalysis).toHaveBeenCalledOnce();
    expect(wrapper.emitted("close")).toHaveLength(1);
    store.isAnalysisCancelling = true;
    await nextTick();
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("aria-busy")).toBe("true");
    expect(button.text()).toBe(t.analysisCancelling);
  });

  it.each([AppState.GAME, AppState.MATE_SEARCH, AppState.ANALYSIS_DIALOG])(
    "does not offer a new analysis in %s",
    (appState) => {
      store.appState = appState;
      expect(
        mountMenu()
          .findAll("button")
          .some((button) => button.text() === t.recordAnalysis),
      ).toBe(false);
    },
  );

  it.each(["retained", "candidate"])(
    "opens a %s game from the ordinary game action rather than a new settings menu",
    async (kind) => {
      store.hasRetainedGame = kind === "retained";
      store.hasGameRecoveryCandidate = kind === "candidate";
      const wrapper = mountMenu();
      const button = wrapper.findAll("button").find((button) => button.text() === t.game)!;
      await button.trigger("click");
      expect(store.showGameDialog).toHaveBeenCalledOnce();
      expect(wrapper.findComponent(MobileGameMenu).exists()).toBe(false);
      expect(wrapper.emitted("close")).toHaveLength(1);
    },
  );

  it("opens the mobile game settings when no game can be recovered", async () => {
    const wrapper = mountMenu();
    const button = wrapper.findAll("button").find((button) => button.text() === t.game)!;
    await button.trigger("click");
    expect(store.showGameDialog).not.toHaveBeenCalled();
    expect(wrapper.findComponent(MobileGameMenu).exists()).toBe(true);
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("closes the menu before waiting for a server destination and saves only on confirmation", async () => {
    const wrapper = mountMenu();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === t.saveToServer)!
      .trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(useFileSaveStore().options).toMatchObject({
      defaultPath: "games/current.jkf",
      server: true,
    });
    expect(store.saveRecord).not.toHaveBeenCalled();
    useFileSaveStore().finish("server://finals/other.kif");
    await flushPromises();
    expect(store.saveRecord).toHaveBeenCalledWith({ path: "server://finals/other.kif" });
  });

  it("does not save when the server destination dialog is cancelled", async () => {
    const wrapper = mountMenu();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === t.saveToServer)!
      .trigger("click");
    useFileSaveStore().finish();
    await flushPromises();
    expect(store.saveRecord).not.toHaveBeenCalled();
  });

  it("reopens the update notice from the menu without applying it", async () => {
    pwaUpdate.available = true;
    const wrapper = mountMenu();
    const button = wrapper.findAll("button").find((button) => button.text() === t.webUpdateMenu)!;
    expect(button).toBeDefined();
    await button.trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(pwaUpdate.show).toHaveBeenCalledOnce();
    expect(pwaUpdate.available).toBe(true);
  });

  it("hides the update action when no update is available", () => {
    expect(
      mountMenu()
        .findAll("button")
        .some((button) => button.text() === t.webUpdateMenu),
    ).toBe(false);
  });

  it("requests only a file name for a local download", async () => {
    isMobileWebApp.mockReturnValue(false);
    const wrapper = mountMenu();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === t.saveAs)!
      .trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(useFileSaveStore().options?.server).toBe(false);
    expect(store.saveRecord).not.toHaveBeenCalled();
    useFileSaveStore().finish("download.jkf");
    await flushPromises();
    expect(store.saveRecord).toHaveBeenCalledWith({ path: "download.jkf" });
  });
});
