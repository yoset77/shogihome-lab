import { shallowMount } from "@vue/test-utils";
import EngineAnalyticsElement from "@/renderer/view/tab/EngineAnalyticsElement.vue";
import { USIInfo, USIPlayerMonitor } from "@/renderer/store/usi";
import { AppState, ResearchState } from "@/common/control/state";
import { reactive } from "vue";
import { Color, Position, Record } from "tsshogi";
import { EvaluationViewFrom } from "@/common/settings/app";
import { parseAnalysisInfo } from "@/common/analysis/types";
import { yaneuraouRepetitionInfos, yaneuraouRepetitionPosition } from "@/tests/helpers/usi";

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
  showPVPreviewDialog: vi.fn(),
});

vi.mock("@/renderer/store", () => ({
  useStore: () => mockStore,
}));

const mockSettings = reactive({
  nodeCountFormat: "comma",
  evaluationViewFrom: EvaluationViewFrom.EACH,
});

vi.mock("@/renderer/store/settings", () => ({
  useAppSettings: () => mockSettings,
}));

describe("EngineAnalyticsElement", () => {
  const monitor = new USIPlayerMonitor(200000, "Test Engine");

  beforeEach(() => {
    mockSettings.evaluationViewFrom = EvaluationViewFrom.EACH;
    mockStore.showPVPreviewDialog.mockClear();
  });

  describe.each([
    { historyMode: false, mobileLayout: false },
    { historyMode: true, mobileLayout: false },
    { historyMode: false, mobileLayout: true },
  ])("PV display $historyMode / $mobileLayout", ({ historyMode, mobileLayout }) => {
    it("renders all real engine candidates including the zero-valued repetition", () => {
      const record = Record.newByUSI(yaneuraouRepetitionPosition) as Record;
      const monitor = new USIPlayerMonitor(200000, "YaneuraOu");
      for (const line of yaneuraouRepetitionInfos)
        monitor.update(record.position.sfen, parseAnalysisInfo(line)!, 100);
      const wrapper = shallowMount(EngineAnalyticsElement, {
        props: { monitor, height: 300, historyMode, mobileLayout },
      });
      const rows = wrapper.findAll(".list-item,.mobile-pv-card");
      expect(rows).toHaveLength(10);
      const repetition = rows.find((row) => row.text().includes("（千日手）"))!;
      expect(repetition.text()).toContain("☖５一玉 （千日手）");
      expect(repetition.find(".score").text()).toMatch(/0$/);
    });

    it.each([
      ["win", "宣言勝ち"],
      ["resign", "投了"],
    ])("renders standalone %s without a preview button", (end, label) => {
      const monitor = new USIPlayerMonitor(200000, "YaneuraOu");
      monitor.update(new Position().sfen, { pv: [end] }, 100);
      const wrapper = shallowMount(EngineAnalyticsElement, {
        props: { monitor, height: 300, historyMode, mobileLayout },
      });
      expect(wrapper.findAll(".list-item,.mobile-pv-card")).toHaveLength(1);
      expect(wrapper.text()).toContain(`（${label}）`);
      expect(wrapper.find("tbody button,.play-button").exists()).toBe(false);
    });

    it("previews only the moves before the ending", async () => {
      const monitor = new USIPlayerMonitor(200000, "YaneuraOu");
      monitor.update(new Position().sfen, { pv: ["7g7f", "rep_draw"] }, 100);
      const wrapper = shallowMount(EngineAnalyticsElement, {
        props: { monitor, height: 300, historyMode, mobileLayout },
      });
      await wrapper.find("tbody button,.play-button").trigger("click");
      const request = mockStore.showPVPreviewDialog.mock.lastCall?.[0];
      expect(request.pv.map((move: { usi: string }) => move.usi)).toEqual(["7g7f"]);
    });
  });

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
  });

  it("should render the stored PV text on mobile without reformatting", () => {
    const mobileMonitor = new USIPlayerMonitor(200001, "Mobile Engine");
    const info: USIInfo = {
      id: 1,
      position: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
      color: Color.BLACK,
      pv: ["7g7f", "3c3d", "2g2f", "8c8d", "2f2e", "8d8e", "6i7h", "4a3b", "4i5h"],
      text: "stored pv text from monitor",
      score: 120,
    };
    mobileMonitor.infoList = [info];

    const wrapper = shallowMount(EngineAnalyticsElement, {
      props: {
        historyMode: false,
        monitor: mobileMonitor,
        height: 300,
        mobileLayout: true,
      },
    });

    expect(wrapper.find(".mobile-pv-text").text()).toBe("stored pv text from monitor");
  });

  it("should swap the bound when the displayed score is inverted", () => {
    const boundedMonitor = new USIPlayerMonitor(200002, "Bounded Engine");
    boundedMonitor.infoList = [
      {
        id: 2,
        position: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1",
        color: Color.WHITE,
        score: 100,
        lowerBound: true,
        pv: ["3c3d"],
        text: "3c3d",
      },
    ];
    mockSettings.evaluationViewFrom = EvaluationViewFrom.BLACK;

    const wrapper = shallowMount(EngineAnalyticsElement, {
      props: {
        historyMode: false,
        monitor: boundedMonitor,
        height: 300,
      },
    });

    expect(wrapper.find("tbody .score").text()).toBe("-100");
    expect(wrapper.find("tbody .score-flag").text()).toBe("--");
  });
});
