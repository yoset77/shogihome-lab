import { enableAutoUnmount, flushPromises, shallowMount } from "@vue/test-utils";
import App from "@/renderer/App.vue";
import { AppState } from "@/common/control/state";
import api, { isMobileWebApp } from "@/renderer/ipc/api";
import { createStore, useStore } from "@/renderer/store";
import { AnalysisManager } from "@/renderer/store/analysis";
import { GameManager } from "@/renderer/store/game";
import { MateSearchManager } from "@/renderer/store/mate";
import { ResearchManager } from "@/renderer/store/research";
import { useBusyState } from "@/renderer/store/busy";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useErrorStore } from "@/renderer/store/error";
import { useToastStore } from "@/renderer/store/toast";
import GameDialog from "@/renderer/view/dialog/GameDialog.vue";
import MobileGameMenu from "@/renderer/view/menu/MobileGameMenu.vue";

vi.mock("@/renderer/ipc/api");
vi.mock("@/renderer/devices/audio");
vi.mock("@/renderer/devices/hotkey");
vi.mock("@/renderer/store/analysis");
vi.mock("@/renderer/store/game");
vi.mock("@/renderer/store/mate");
vi.mock("@/renderer/store/research");
vi.mock("@/renderer/store", async (original) => ({
  ...(await original<typeof import("@/renderer/store")>()),
  useStore: vi.fn(),
}));

enableAutoUnmount(afterEach);

describe("app game settings routing", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(AnalysisManager.prototype.on).mockReturnThis();
    vi.mocked(GameManager.prototype.on).mockReturnThis();
    vi.mocked(MateSearchManager.prototype.on).mockReturnThis();
    vi.mocked(ResearchManager.prototype.on).mockReturnThis();
    vi.spyOn(GameManager.prototype, "hasRetainedSession", "get").mockReturnValue(false);
    vi.spyOn(GameManager.prototype, "hasRecoveryCandidate", "get").mockReturnValue(true);
    vi.spyOn(document.body, "addEventListener").mockImplementation(() => {});
  });

  afterEach(() => {
    useConfirmationStore().cancel();
    useErrorStore().clear();
    useToastStore().clear();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it.each([
    { mobile: true, confirm: false },
    { mobile: true, confirm: true },
    { mobile: false, confirm: false },
    { mobile: false, confirm: true },
  ])(
    "opens the matching settings after candidate cleanup (mobile: $mobile, confirm: $confirm)",
    async ({ mobile, confirm }) => {
      vi.mocked(isMobileWebApp).mockReturnValue(mobile);
      const candidate = vi.spyOn(GameManager.prototype, "hasRecoveryCandidate", "get");
      vi.mocked(GameManager.prototype.recover).mockImplementation(async (confirmRecovery) => {
        if (confirm) await confirmRecovery();
        candidate.mockReturnValue(false);
        return false;
      });
      const store = createStore();
      vi.mocked(useStore).mockReturnValue(store);
      const wrapper = shallowMount(App);
      expect(wrapper.findComponent(GameDialog).exists()).toBe(false);
      expect(wrapper.findComponent(MobileGameMenu).exists()).toBe(false);

      store.showGameDialog();
      if (confirm) useConfirmationStore().ok();
      await flushPromises();

      expect(store.appState).toBe(AppState.GAME_DIALOG);
      expect(wrapper.findComponent(MobileGameMenu).exists()).toBe(mobile);
      expect(wrapper.findComponent(GameDialog).exists()).toBe(!mobile);
      expect(GameManager.prototype.recover).toHaveBeenCalledOnce();
      expect(GameManager.prototype.start).not.toHaveBeenCalled();
      expect(useToastStore().toasts).toEqual([]);
      expect(useBusyState().isBusy).toBe(false);

      if (mobile) {
        wrapper.getComponent(MobileGameMenu).vm.$emit("close");
        await flushPromises();
        expect(store.appState).toBe(AppState.NORMAL);
        expect(wrapper.findComponent(MobileGameMenu).exists()).toBe(false);
        expect(GameManager.prototype.start).not.toHaveBeenCalled();
        expect(api.saveGameSettings).not.toHaveBeenCalled();
      }
    },
  );

  it.each([true, false])(
    "does not open settings after cancelling recovery (mobile: %s)",
    async (mobile) => {
      vi.mocked(isMobileWebApp).mockReturnValue(mobile);
      const candidate = vi.spyOn(GameManager.prototype, "hasRecoveryCandidate", "get");
      vi.mocked(GameManager.prototype.recover).mockImplementation(async (confirmRecovery) => {
        const confirmed = await confirmRecovery();
        candidate.mockReturnValue(false);
        return confirmed;
      });
      const store = createStore();
      vi.mocked(useStore).mockReturnValue(store);
      const wrapper = shallowMount(App);

      store.showGameDialog();
      useConfirmationStore().cancel();
      await flushPromises();

      expect(store.appState).toBe(AppState.NORMAL);
      expect(wrapper.findComponent(GameDialog).exists()).toBe(false);
      expect(wrapper.findComponent(MobileGameMenu).exists()).toBe(false);
      expect(GameManager.prototype.start).not.toHaveBeenCalled();
      expect(useToastStore().toasts).toEqual([]);
      expect(useBusyState().isBusy).toBe(false);
    },
  );
});
