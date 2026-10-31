import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import {
  defaultAppSettings,
  Tab,
  TabPaneType,
  type AppSettingsUpdate,
} from "@/common/settings/app";
import { GameViewState, type GameViewSettings } from "@/renderer/store/game_view";
import StandardLayout from "@/renderer/view/main/StandardLayout.vue";
import RecordPane from "@/renderer/view/main/RecordPane.vue";
import BoardPane from "@/renderer/view/main/BoardPane.vue";
import TabPane from "@/renderer/view/main/TabPane.vue";

const { useStore, useAppSettings } = vi.hoisted(() => ({
  useStore: vi.fn(),
  useAppSettings: vi.fn(),
}));
vi.mock("@/renderer/store", () => ({ useStore }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings }));
vi.mock("@/renderer/ipc/api", () => ({ default: { log: vi.fn() } }));

const app = reactive({
  ...defaultAppSettings(),
  updateAppSettings: vi.fn(async (update: AppSettingsUpdate) => Object.assign(app, update)),
});
const view = reactive(new GameViewState());
const store = {
  get gameViewSettings() {
    return view.settings;
  },
  updateGameViewSettings: (update: Partial<GameViewSettings>) => view.update(app, update),
};
const mountLayout = () =>
  mount(StandardLayout, {
    attachTo: document.body,
    global: {
      stubs: {
        BoardPane: true,
        RecordPane: true,
        ControlPane: true,
        TabPane: true,
        RecordComment: true,
        Icon: true,
      },
    },
  });
type LayoutWrapper = ReturnType<typeof mountLayout>;
const topSize = (wrapper: LayoutWrapper) => wrapper.findAllComponents(Pane)[0].props("size");

enableAutoUnmount(afterEach);

describe("PC game view preset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(app, defaultAppSettings());
    app.updateAppSettings.mockClear();
    view.setActive(false, app);
    useStore.mockReturnValue(store);
    useAppSettings.mockReturnValue(app);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(Object.values(TabPaneType))("temporarily hides every %s layout", async (tabPaneType) => {
    app.tabPaneType = tabPaneType;
    const original = { ...app };
    const wrapper = mountLayout();
    expect(topSize(wrapper)).toBe(60);
    expect(wrapper.getComponent(RecordPane).props("showComment")).toBe(true);
    view.setActive(true, app);
    await nextTick();
    expect(topSize(wrapper)).toBe(100);
    expect(wrapper.getComponent(RecordPane).props("showComment")).toBe(false);
    expect(wrapper.getComponent(BoardPane).props("hideCandidates")).toBe(true);
    expect(wrapper.findAllComponents(TabPane).every((pane) => !pane.isVisible())).toBe(true);

    await wrapper.get(".unhide-tabview-button").trigger("click");
    expect(topSize(wrapper)).toBe(60);
    expect(wrapper.findAllComponents(TabPane).every((pane) => pane.isVisible())).toBe(true);
    wrapper.findAllComponents(TabPane)[0].vm.$emit("onChangeTab", Tab.PV);
    await nextTick();
    expect(view.settings?.tab).toBe(Tab.PV);
    expect(wrapper.getComponent(BoardPane).props("hideCandidates")).toBe(true);

    view.setActive(false, app);
    await nextTick();
    expect(topSize(wrapper)).toBe(60);
    expect(wrapper.getComponent(RecordPane).props("showComment")).toBe(true);
    expect(wrapper.getComponent(BoardPane).props("hideCandidates")).toBe(false);
    expect(wrapper.findAllComponents(TabPane)[0].props("activeTab")).toBe(original.tab);
    expect(app.updateAppSettings).not.toHaveBeenCalled();
    expect(app).toEqual(original);
  });

  it("starts hidden on the first render when restoring an active game", () => {
    view.setActive(true, app);
    const wrapper = mountLayout();
    expect(topSize(wrapper)).toBe(100);
    expect(wrapper.getComponent(RecordPane).props("showComment")).toBe(false);
    expect(wrapper.getComponent(BoardPane).props("hideCandidates")).toBe(true);
  });

  it("allows divider dragging and clears delayed resizing when the game ends", async () => {
    const wrapper = mountLayout();
    const main = wrapper.findAllComponents(Splitpanes)[0];
    view.setActive(true, app);
    await nextTick();
    main.vm.$emit("resized", { panes: [{ size: 45 }], event: new Event("mouseup") });
    await nextTick();
    expect(topSize(wrapper)).toBe(45);
    expect(view.settings?.topPaneHeightPercentage).toBe(45);
    main.vm.$emit("resize", { panes: [{ size: 30 }] });
    view.setActive(false, app);
    await vi.advanceTimersByTimeAsync(100);
    expect(topSize(wrapper)).toBe(60);
    expect(app.updateAppSettings).not.toHaveBeenCalled();
  });

  it.each([TabPaneType.DOUBLE, TabPaneType.DOUBLE_V2])(
    "restores both real Splitpanes widths after a game-only resize in %s",
    async (tabPaneType) => {
      app.tabPaneType = tabPaneType;
      const original = { ...app };
      const wrapper = mountLayout();
      const bottom = wrapper.get(".bottom-frame");
      const widths = () =>
        bottom
          .findAll(".splitpanes__pane")
          .map((pane) => (pane.element as HTMLElement).style.width);
      await nextTick();
      expect(widths()).toEqual(["60%", "40%"]);

      view.setActive(true, app);
      await nextTick();
      await wrapper.get(".unhide-tabview-button").trigger("click");
      const divider = bottom.get(".splitpanes__splitter");
      for (let i = 0; i < 4; ++i) {
        await divider.trigger("keydown", { key: "ArrowLeft" });
      }
      expect(widths()).toEqual(["40%", "60%"]);
      expect(view.settings?.bottomLeftPaneWidthPercentage).toBe(40);

      view.setActive(false, app);
      await nextTick();
      expect(widths()).toEqual(["60%", "40%"]);
      expect(app.updateAppSettings).not.toHaveBeenCalled();
      expect(app).toEqual(original);
    },
  );

  it("does not persist programmatic Splitpanes resize events", async () => {
    const wrapper = mountLayout();
    const main = wrapper.findAllComponents(Splitpanes)[0];
    main.vm.$emit("resized", { panes: [{ size: 100 }] });
    view.setActive(true, app);
    await nextTick();
    main.vm.$emit("resized", { panes: [{ size: 100 }] });
    view.setActive(false, app);
    await nextTick();
    main.vm.$emit("resized", { panes: [{ size: 60 }] });
    expect(topSize(wrapper)).toBe(60);
    expect(app.updateAppSettings).not.toHaveBeenCalled();
  });

  it("preserves a layout that was already minimized before the game", async () => {
    app.topPaneHeightPercentage = 100;
    app.topPanePreviousHeightPercentage = 45;
    view.setActive(true, app);
    const wrapper = mountLayout();
    await wrapper.get(".unhide-tabview-button").trigger("click");
    expect(topSize(wrapper)).toBe(45);
    view.setActive(false, app);
    await nextTick();
    expect(topSize(wrapper)).toBe(100);
  });

  it("continues to persist manual layout changes outside the preset", async () => {
    const wrapper = mountLayout();
    wrapper
      .findAllComponents(TabPane)
      .find((pane) => pane.props("displayMinimizeToggle"))!
      .vm.$emit("onMinimize");
    await nextTick();
    expect(topSize(wrapper)).toBe(100);
    expect(app.updateAppSettings).toHaveBeenCalledWith({ topPaneHeightPercentage: 100 });
  });
});
