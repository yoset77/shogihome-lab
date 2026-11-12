import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { RectSize } from "@/common/assets/geometry";
import { AppState } from "@/common/control/state";
import { defaultAppSettings, Tab } from "@/common/settings/app";
import TabPane, { headerHeight } from "@/renderer/view/main/TabPane.vue";
import PuzzlePane from "@/renderer/view/tab/PuzzlePane.vue";
import RecordInfo from "@/renderer/view/tab/RecordInfo.vue";
import EvaluationChart from "@/renderer/view/tab/EvaluationChart.vue";

const { useStore, useAppSettings } = vi.hoisted(() => ({
  useStore: vi.fn(),
  useAppSettings: vi.fn(),
}));
vi.mock("@/renderer/store", () => ({ useStore }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings }));
vi.mock("@/renderer/ipc/api", () => ({ default: {} }));

enableAutoUnmount(afterEach);

describe("TabPane", () => {
  it("passes the updated numeric score range to both chart tabs", async () => {
    const settings = reactive(defaultAppSettings());
    settings.evaluationChartRange = "1000";
    useStore.mockReturnValue({ appState: AppState.NORMAL });
    useAppSettings.mockReturnValue(settings);
    const wrapper = shallowMount(TabPane, {
      props: {
        size: new RectSize(400, 300),
        visibleTabs: [Tab.CHART, Tab.PERCENTAGE_CHART],
        activeTab: Tab.CHART,
      },
    });

    expect(wrapper.getComponent(EvaluationChart).props("scoreRange")).toBe(1000);
    settings.evaluationChartRange = "1500";
    await nextTick();
    expect(wrapper.getComponent(EvaluationChart).props("scoreRange")).toBe(1500);

    await wrapper.setProps({ activeTab: Tab.PERCENTAGE_CHART });
    expect(wrapper.getComponent(EvaluationChart).props("scoreRange")).toBe(1500);
    settings.evaluationChartRange = "1000";
    await nextTick();
    expect(wrapper.getComponent(EvaluationChart).props("scoreRange")).toBe(1000);
  });

  it("only replaces the tabs when puzzles are allowed and restores them afterward", async () => {
    const store = reactive({
      appState: AppState.PUZZLE as AppState,
      puzzle: { type: "evaluation" as string | undefined },
    });
    useStore.mockReturnValue(store);
    useAppSettings.mockReturnValue(defaultAppSettings());
    const size = new RectSize(400, 300);
    const wrapper = shallowMount(TabPane, {
      props: { size, visibleTabs: [Tab.RECORD_INFO], activeTab: Tab.RECORD_INFO },
    });

    expect(wrapper.find(".tabs").exists()).toBe(true);
    expect(wrapper.findComponent(PuzzlePane).exists()).toBe(false);
    expect(wrapper.getComponent(RecordInfo).props("size")).toEqual(
      new RectSize(400, 300 - headerHeight),
    );

    await wrapper.setProps({ allowPuzzle: true });
    expect(wrapper.find(".tabs").exists()).toBe(false);
    expect(wrapper.findComponent(PuzzlePane).exists()).toBe(true);
    expect(wrapper.findComponent(RecordInfo).exists()).toBe(false);

    store.puzzle.type = "next_move";
    await nextTick();
    expect(wrapper.find(".tabs").exists()).toBe(true);
    expect(wrapper.findComponent(PuzzlePane).exists()).toBe(false);
    expect(wrapper.getComponent(RecordInfo).props("size")).toEqual(
      new RectSize(400, 300 - headerHeight),
    );

    store.puzzle.type = undefined;
    await nextTick();
    expect(wrapper.find(".tabs").exists()).toBe(true);
    expect(wrapper.findComponent(PuzzlePane).exists()).toBe(false);

    store.puzzle.type = "evaluation";
    store.appState = AppState.NORMAL;
    await nextTick();
    expect(wrapper.find(".tabs").exists()).toBe(true);
    expect(wrapper.findComponent(PuzzlePane).exists()).toBe(false);
  });
});
