import { enableAutoUnmount, flushPromises, shallowMount } from "@vue/test-utils";
import { Record } from "tsshogi";
import App from "@/renderer/App.vue";
import { AppState } from "@/common/control/state";
import { exportRecordAsBuffer, RecordFileFormat } from "@/common/file/record";
import api, { isMobileWebApp } from "@/renderer/ipc/api";
import { webAPI } from "@/renderer/ipc/web";
import { createStore, useStore } from "@/renderer/store";
import { AnalysisManager } from "@/renderer/store/analysis";
import { GameManager } from "@/renderer/store/game";
import { MateSearchManager } from "@/renderer/store/mate";
import { ResearchManager } from "@/renderer/store/research";
import { useBusyState } from "@/renderer/store/busy";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useErrorStore } from "@/renderer/store/error";
import { useFileSaveStore } from "@/renderer/store/fileSave";
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

function dispatchFileDrop(file: File): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
  document.body.dispatchEvent(event);
  return event;
}

describe("renderer/App", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(AnalysisManager.prototype.on).mockReturnThis();
    vi.mocked(GameManager.prototype.on).mockReturnThis();
    vi.mocked(MateSearchManager.prototype.on).mockReturnThis();
    vi.mocked(ResearchManager.prototype.on).mockReturnThis();
    vi.spyOn(GameManager.prototype, "hasRetainedSession", "get").mockReturnValue(false);
    vi.spyOn(GameManager.prototype, "hasRecoveryCandidate", "get").mockReturnValue(true);
  });

  afterEach(() => {
    useConfirmationStore().cancel();
    useErrorStore().clear();
    useToastStore().clear();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("opens a dropped local KIF and backs it up in history", async () => {
    const usi = "position startpos moves 7g7f";
    const record = Record.newByUSI(usi);
    if (record instanceof Error) throw record;
    const exported = exportRecordAsBuffer(record, RecordFileFormat.KIF, {});
    if (exported instanceof Error) throw exported;
    const data = new Uint8Array(exported.data);
    const file = new File([data], "dropped.kif");
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.resolve(data.buffer),
    });
    vi.mocked(api.readLocalRecordFile).mockImplementation(webAPI.readLocalRecordFile);
    vi.mocked(api.saveRecordFileBackup).mockResolvedValue(undefined);
    const store = createStore();
    vi.mocked(useStore).mockReturnValue(store);
    shallowMount(App);

    expect(dispatchFileDrop(file).defaultPrevented).toBe(true);
    await flushPromises();

    expect(store.record.getUSI({ startpos: true, allMoves: true })).toBe(usi);
    expect(store.recordFilePath).toMatch(/^es:\/\/temp-file\/.+\/dropped\.kif$/);
    expect(api.openRecord).not.toHaveBeenCalled();
    expect(api.showOpenRecordDialog).not.toHaveBeenCalled();
    expect(api.addRecordFileHistory).not.toHaveBeenCalled();
    expect(api.saveRecordFileBackup).toHaveBeenCalledOnce();
    expect(useErrorStore().hasError).toBe(false);
  });

  it.each([false, true])(
    "ignores drops while the save dialog is open (server: %s)",
    async (server) => {
      const usi = "position startpos moves 7g7f";
      const store = createStore();
      store.pasteRecord(usi);
      vi.mocked(useStore).mockReturnValue(store);
      shallowMount(App);
      const fileSave = useFileSaveStore();
      const selection = fileSave.show({
        title: "Save",
        defaultPath: "original.kifu",
        server,
        extensions: [RecordFileFormat.KIFU],
      });

      expect(dispatchFileDrop(new File([], "replacement.kifu")).defaultPrevented).toBe(true);
      await flushPromises();

      expect(api.readLocalRecordFile).not.toHaveBeenCalled();
      expect(store.record.getUSI({ startpos: true, allMoves: true })).toBe(usi);
      expect(fileSave.options?.defaultPath).toBe("original.kifu");
      expect(useErrorStore().hasError).toBe(false);
      fileSave.finish();
      await selection;
    },
  );

  it("keeps the current record when a dropped file cannot be read", async () => {
    const usi = "position startpos moves 7g7f";
    const file = new File([], "unreadable.kif");
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockRejectedValue(new Error("cannot read file")),
    });
    vi.mocked(api.readLocalRecordFile).mockImplementation(webAPI.readLocalRecordFile);
    const store = createStore();
    store.pasteRecord(usi);
    vi.mocked(useStore).mockReturnValue(store);
    shallowMount(App);

    dispatchFileDrop(file);
    await flushPromises();

    expect(store.record.getUSI({ startpos: true, allMoves: true })).toBe(usi);
    expect(api.saveRecordFileBackup).not.toHaveBeenCalled();
    expect(useErrorStore().errors[0]?.message).toContain("cannot read file");
    expect(useBusyState().isBusy).toBe(false);
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
