import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KifuSearchStatistics } from "@/common/file/kifu_statistics";
import type { KifuSearchQuery } from "@/common/file/sfen_export";
import { t } from "@/common/i18n";
import KifuStatisticsDialog from "@/renderer/view/dialog/KifuStatisticsDialog.vue";
import { useKifuStatistics } from "@/renderer/store/kifuStatistics";

const getStatistics = vi.hoisted(() => vi.fn());
vi.mock("@/renderer/ipc/api", () => ({ default: { getServerKifuStatistics: getStatistics } }));

const result = (total = 125): KifuSearchStatistics => ({
  total,
  generatedAt: 100,
  strategies: total ? [{ strategy: "unclassified", count: total }] : [],
  players: total
    ? [
        { name: "A", black: total, white: 0, total },
        { name: null, black: 0, white: total, total },
      ]
    : [],
  otherPlayers: { black: 0, white: 0, total: 0 },
});
const mountDialog = (search: KifuSearchQuery = { keyword: "executed" }, searchResultCount = 125) =>
  shallowMount(KifuStatisticsDialog, {
    props: { search, searchResultCount },
    global: { stubs: { DialogFrame: { template: "<div><slot /></div>" } } },
  });

describe("KifuStatisticsDialog", () => {
  beforeEach(() => {
    getStatistics.mockReset();
    getStatistics.mockResolvedValue(result());
  });

  it("loads statistics on demand and uses the executed query for recalculation", async () => {
    const query = { keyword: "executed" };
    const wrapper = mountDialog(query);
    await flushPromises();
    expect(wrapper.text()).toContain(t.kifuStatisticsTargetCount(125));
    expect(wrapper.text()).toContain("100.0%");
    expect(wrapper.text()).toContain(t.kifuStatisticsMissingPlayer);
    expect(wrapper.find(".players tfoot").exists()).toBe(false);
    query.keyword = "edited";
    await wrapper.setProps({ search: { keyword: "new form" } });
    expect(getStatistics).toHaveBeenCalledTimes(1);
    await wrapper.find(".main-buttons button").trigger("click");
    await flushPromises();
    expect(getStatistics).toHaveBeenLastCalledWith({ keyword: "executed" });
    wrapper.unmount();
  });

  it("keeps the executed search count as the recalculation baseline when props change", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.text()).not.toContain(t.kifuStatisticsCountChanged);
    await wrapper.setProps({ search: { keyword: "new search" }, searchResultCount: 64 });
    getStatistics.mockResolvedValue(result(64));
    await wrapper.find(".main-buttons button").trigger("click");
    await flushPromises();
    expect(getStatistics).toHaveBeenLastCalledWith({ keyword: "executed" });
    expect(wrapper.text()).toContain(t.kifuStatisticsCountChanged);

    getStatistics.mockResolvedValue(result());
    await wrapper.find(".main-buttons button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).not.toContain(t.kifuStatisticsCountChanged);
    wrapper.unmount();
  });

  it("aggregates next moves for position search and keeps missing states apart", async () => {
    getStatistics.mockResolvedValue({
      ...result(3),
      nextMoves: [
        { move: "☗２五歩", count: 1 },
        { move: "", count: 1 },
        { move: null, count: 1 },
      ],
    });
    const wrapper = mountDialog({ sfen: "position sfen" }, 3);
    await flushPromises();
    expect(wrapper.text()).toContain(t.nextMoves);
    expect(wrapper.text()).toContain("☗２五歩");
    expect(wrapper.text()).toContain(t.kifuNoContinuation);
    expect(wrapper.text()).toContain(t.kifuNextMoveUnavailable);
    expect(wrapper.text()).toContain("33.3%");
    wrapper.unmount();
  });

  it("hides next moves outside position search or when they are missing", async () => {
    getStatistics.mockResolvedValue({ ...result(), nextMoves: [{ move: "☗２五歩", count: 125 }] });
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.text()).not.toContain(t.nextMoves);
    wrapper.unmount();

    getStatistics.mockResolvedValue(result());
    const positionWrapper = mountDialog({ sfen: "position sfen" });
    await flushPromises();
    expect(positionWrapper.text()).not.toContain(t.nextMoves);
    positionWrapper.unmount();
  });

  it("shows loading and keeps close available while the request is pending", async () => {
    let resolve!: (value: KifuSearchStatistics) => void;
    getStatistics.mockReturnValue(
      new Promise<KifuSearchStatistics>((r) => {
        resolve = r;
      }),
    );
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain(t.kifuStatisticsLoading);
    expect(wrapper.find(".main-buttons button").attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-hotkey="Escape"]').attributes("disabled")).toBeUndefined();
    resolve(result());
    await flushPromises();
    wrapper.unmount();
  });

  it("reports an updated index and displays an empty result without percentages", async () => {
    getStatistics.mockResolvedValue(result(0));
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.text()).toContain(t.kifuStatisticsCountChanged);
    expect(wrapper.text()).toContain(t.noKifuFound);
    expect(wrapper.find("table").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("NaN");
    wrapper.unmount();
  });

  it("shows failures in the dialog and allows retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getStatistics.mockRejectedValueOnce(new Error("network"));
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toBe(t.kifuStatisticsFailed);
    expect(wrapper.find(".main-buttons button").attributes("disabled")).toBeUndefined();
    await wrapper.find(".main-buttons button").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find("table").exists()).toBe(true);
    wrapper.unmount();
    warn.mockRestore();
  });

  it("shows the top fifty players and omitted appearances without pagination or changing totals", async () => {
    getStatistics.mockResolvedValue({
      ...result(60),
      players: Array.from({ length: 50 }, (_, i) => ({
        name: `Player ${i}`,
        black: 1,
        white: 1,
        total: 2,
      })),
      otherPlayers: { black: 10, white: 10, total: 20 },
    });
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.findAll(".players tbody tr")).toHaveLength(50);
    expect(wrapper.find(".pagination").exists()).toBe(false);
    expect(wrapper.text()).toContain(t.kifuStatisticsTopPlayers(50));
    expect(wrapper.findAll(".players tfoot td").map((cell) => cell.text())).toEqual([
      t.kifuStatisticsOtherPlayers,
      "10",
      "10",
      "20",
    ]);
    expect(wrapper.text()).toContain(t.kifuStatisticsTargetCount(60));
    expect(getStatistics).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("keeps the strategy caveat and player cap visible while collapsing secondary notes", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.find("section p.note").text()).toBe(t.kifuStatisticsStrategyNote);
    expect(wrapper.text()).toContain(t.kifuStatisticsTopPlayers(50));
    const notes = wrapper.find("details.notes");
    expect(notes.find("summary").text()).toBe(t.kifuStatisticsAbout);
    expect(notes.text()).toContain(t.kifuStatisticsFileNote);
    expect(notes.text()).toContain(t.kifuStatisticsPlayerNote);
    wrapper.unmount();
  });

  it("closes only its own dialog", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.find('[data-hotkey="Escape"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("ignores late requests after disposal and avoids concurrent recalculation", async () => {
    let resolve!: (value: KifuSearchStatistics) => void;
    getStatistics.mockReturnValue(
      new Promise<KifuSearchStatistics>((r) => {
        resolve = r;
      }),
    );
    const state = useKifuStatistics({ keyword: "executed" }, 125);
    const pending = state.reload();
    await state.reload();
    expect(getStatistics).toHaveBeenCalledTimes(1);
    state.dispose();
    resolve(result());
    await pending;
    expect(state.statistics.value).toBeUndefined();
  });
});
