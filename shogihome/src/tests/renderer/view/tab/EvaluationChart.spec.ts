import { mount } from "@vue/test-utils";
import { Color } from "tsshogi";
import { RectSize } from "@/common/assets/geometry";
import { Thema } from "@/common/settings/app";
import { EvaluationChartType } from "@/common/settings/layout";
import EvaluationChart from "@/renderer/view/tab/EvaluationChart.vue";

type MockChart = {
  data: { datasets: { data: { x: number; y: number }[] }[] };
  options: { scales: { y: object } };
};

const { charts, store } = vi.hoisted(() => ({
  charts: [] as MockChart[],
  store: {
    record: {
      length: 3,
      current: { ply: 2 },
      moves: [
        { ply: 1, nextColor: "white", customData: { playerSearchInfo: { score: 1200 } } },
        { ply: 2, nextColor: "black", customData: { playerSearchInfo: { score: -1800 } } },
        { ply: 3, nextColor: "white", customData: { playerSearchInfo: { mate: 1 } } },
      ],
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    changePly: vi.fn(),
  },
}));

vi.mock("@/renderer/store", () => ({ useStore: () => store }));
vi.mock("chart.js", () => ({
  Chart: class {
    data: MockChart["data"] = { datasets: [] };
    options: MockChart["options"] = { scales: { y: {} } };
    update = vi.fn();
    draw = vi.fn();
    destroy = vi.fn();
    constructor() {
      charts.push(this);
    }
  },
}));

describe("EvaluationChart", () => {
  beforeEach(() => {
    charts.length = 0;
    store.record.moves[0].nextColor = Color.WHITE;
    store.record.moves[1].nextColor = Color.BLACK;
    store.record.moves[2].nextColor = Color.WHITE;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  it("updates the raw score bounds, clipped values, and position line when the range changes", async () => {
    const wrapper = mount(EvaluationChart, {
      props: {
        size: new RectSize(400, 200),
        type: EvaluationChartType.RAW,
        thema: Thema.STANDARD,
        coefficientInSigmoid: 600,
        scoreRange: 2000,
      },
    });
    const chart = charts[0];
    for (const range of [2000, 1500, 1000]) {
      await wrapper.setProps({ scoreRange: range });
      expect(chart.options.scales.y).toMatchObject({
        min: -range,
        max: range,
        ticks: { stepSize: range / 2 },
      });
      expect(chart.data.datasets[0].data).toEqual([
        { x: 2, y: range },
        { x: 2, y: -range },
      ]);
      expect(chart.data.datasets[1].data).toEqual([
        { x: 1, y: Math.min(1200, range) },
        { x: 3, y: range },
      ]);
      expect(chart.data.datasets[2].data).toEqual([{ x: 2, y: Math.max(-1800, -range) }]);
    }
    wrapper.unmount();
  });

  it("keeps the win rate chart unchanged when the score range changes", async () => {
    const wrapper = mount(EvaluationChart, {
      props: {
        size: new RectSize(400, 200),
        type: EvaluationChartType.WIN_RATE,
        thema: Thema.STANDARD,
        coefficientInSigmoid: 600,
        scoreRange: 2000,
      },
    });
    const chart = charts[0];
    const originalDatasets = structuredClone(chart.data.datasets);
    await wrapper.setProps({ scoreRange: 1000 });
    expect(chart.options.scales.y).toMatchObject({ min: 0, max: 100, ticks: { stepSize: 25 } });
    expect(chart.data.datasets).toEqual(originalDatasets);
    wrapper.unmount();
  });
});
