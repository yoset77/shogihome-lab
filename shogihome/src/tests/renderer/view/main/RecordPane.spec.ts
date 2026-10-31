import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { Record } from "tsshogi";
import { AppState } from "@/common/control/state";
import { defaultAppSettings } from "@/common/settings/app";
import RecordPane from "@/renderer/view/main/RecordPane.vue";
import RecordView from "@/renderer/view/primitive/RecordView.vue";

const { useStore, useAppSettings } = vi.hoisted(() => ({
  useStore: vi.fn(),
  useAppSettings: vi.fn(),
}));
vi.mock("@/renderer/store", () => ({ useStore }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings }));
vi.mock("@/renderer/devices/hotkey", () => ({
  installHotKeyForMainWindow: vi.fn(),
  uninstallHotKeyForMainWindow: vi.fn(),
}));
const app = { ...defaultAppSettings(), updateAppSettings: vi.fn() };
const store = {
  appState: AppState.GAME,
  record: new Record(),
  updateGameViewSettings: vi.fn(),
};
enableAutoUnmount(afterEach);

describe("record comment visibility", () => {
  beforeEach(() => {
    store.updateGameViewSettings.mockReset().mockReturnValue(false);
    app.updateAppSettings.mockClear();
    useStore.mockReturnValue(store);
    useAppSettings.mockReturnValue(app);
  });

  it("routes comment toggles to the game view without saving ordinary preferences", () => {
    store.updateGameViewSettings.mockReturnValue(true);
    const wrapper = shallowMount(RecordPane, { props: { showComment: false } });
    wrapper.getComponent(RecordView).vm.$emit("toggleShowComment", true);
    wrapper.getComponent(RecordView).vm.$emit("toggleShowComment", false);
    expect(store.updateGameViewSettings.mock.calls).toEqual([
      [{ showCommentInRecordView: true }],
      [{ showCommentInRecordView: false }],
    ]);
    expect(app.updateAppSettings).not.toHaveBeenCalled();
  });

  it("keeps saving comment preferences outside the PC preset", () => {
    const wrapper = shallowMount(RecordPane, { props: { showComment: true } });
    wrapper.getComponent(RecordView).vm.$emit("toggleShowComment", false);
    expect(store.updateGameViewSettings).toHaveBeenCalledWith({ showCommentInRecordView: false });
    expect(app.updateAppSettings).toHaveBeenCalledWith({ showCommentInRecordView: false });
  });
});
