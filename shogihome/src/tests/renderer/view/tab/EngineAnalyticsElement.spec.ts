import { shallowMount } from "@vue/test-utils";
import EngineAnalyticsElement from "@/renderer/view/tab/EngineAnalyticsElement.vue";
import { USIPlayerMonitor } from "@/renderer/store/usi";
import { AppState, ResearchState } from "@/common/control/state.js";
import { reactive } from "vue";

// Mock store and settings
const mockStore = reactive({
  researchState: ResearchState.IDLE,
  appState: AppState.NORMAL,
  _isResearchEngine: true,
  _isPaused: false,
  isResearchEngineSessionID() {
    return this._isResearchEngine;
  },
  isPausedResearchEngine() {
    return this._isPaused;
  },
  getResearchMultiPV: vi.fn(),
});

vi.mock("@/renderer/store", () => ({
  useStore: () => mockStore,
}));

vi.mock("@/renderer/store/settings", () => ({
  useAppSettings: () => ({
    nodeCountFormat: "comma",
    evaluationViewFrom: "each",
  }),
}));

describe("EngineAnalyticsElement", () => {
  const monitor = new USIPlayerMonitor(200000, "Test Engine");

  it("paused logic for research session on mobile", async () => {
    mockStore._isResearchEngine = true;
    mockStore._isPaused = false;
    mockStore.researchState = ResearchState.IDLE;

    const wrapper = shallowMount(EngineAnalyticsElement, {
      props: {
        historyMode: false,
        monitor,
        height: 300,
        mobileLayout: true,
      },
    });

    const vm = wrapper.vm as unknown as { paused: boolean; $nextTick: () => Promise<void> };

    // Research engine, not running -> should be paused
    expect(vm.paused).toBe(true);

    // Research engine, running -> should not be paused
    mockStore.researchState = ResearchState.RUNNING;
    await vm.$nextTick();
    expect(vm.paused).toBe(false);

    // Research engine, running but individually paused -> should be paused
    mockStore._isPaused = true;
    await vm.$nextTick();
    expect(vm.paused).toBe(true);
  });

  it("paused logic for game session on mobile", async () => {
    mockStore._isResearchEngine = false; // Game session
    mockStore.appState = AppState.NORMAL;

    const wrapper = shallowMount(EngineAnalyticsElement, {
      props: {
        historyMode: false,
        monitor,
        height: 300,
        mobileLayout: true,
      },
    });

    const vm = wrapper.vm as unknown as { paused: boolean; $nextTick: () => Promise<void> };

    // Game engine, app not in game -> should be paused
    expect(vm.paused).toBe(true);

    // Game engine, app in game -> should NOT be paused
    mockStore.appState = AppState.GAME;
    await vm.$nextTick();
    expect(vm.paused).toBe(false);

    // Game engine, app in CSA game -> should NOT be paused
    mockStore.appState = AppState.CSA_GAME;
    await vm.$nextTick();
    expect(vm.paused).toBe(false);
  });
});
