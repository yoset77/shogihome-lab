import { flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/common/i18n";
import { useServerKifuStore } from "@/renderer/store/serverKifu";
import ServerKifuDialog from "@/renderer/view/dialog/ServerKifuDialog.vue";

vi.mock("@/renderer/ipc/api", () => ({
  default: {
    listServerKifu: vi.fn(async () => []),
    getServerKifuIndexStatus: vi.fn(async () => ({ total: 0, indexed: 0, isIndexing: false })),
  },
}));
const closeModalDialog = vi.hoisted(() => vi.fn());
const showBatchAnalysisDialog = vi.hoisted(() => vi.fn());
vi.mock("@/renderer/store", () => ({
  useStore: () => ({
    closeModalDialog,
    showBatchAnalysisDialog,
    setOnPasteHandler: vi.fn(),
    dequeuePendingPasteData: vi.fn(),
  }),
}));
vi.mock("@/renderer/store/busy", () => ({
  useBusyState: () => ({ retain: vi.fn(), release: vi.fn() }),
}));

const mountDialog = () =>
  shallowMount(ServerKifuDialog, {
    global: {
      stubs: {
        DialogFrame: { template: "<div><slot /></div>" },
      },
    },
  });

describe("ServerKifuDialog search result behavior", () => {
  beforeEach(() => {
    const state = useServerKifuStore();
    state.activeTab.value = "results";
    state.lastExecutedSearch.value = { sfen: state.searchRecord.value.position.sfen };
    state.searchResultCount.value = 4;
    state.searchResults.value = ["☗７六歩", "投了", "", null].map((next_move, id) => ({
      id,
      file_path: `${id}.kif`,
      mtime: 1,
      size: 1,
      indexed_at: 1,
      next_move,
      matched_is_variation: id === 2,
    }));
    closeModalDialog.mockReset();
    showBatchAnalysisDialog.mockReset();
  });
  afterEach(() => {
    const state = useServerKifuStore();
    state.searchResults.value = [];
    state.searchResultCount.value = 0;
    state.lastExecutedSearch.value = undefined;
  });

  it("shows moves, special endings, absent continuations and unavailable data separately", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const rows = wrapper.findAll(".next-move");
    expect(rows.map((row) => row.text())).toEqual([
      `${t.nextMoves}: ☗７六歩`,
      `${t.nextMoves}: 投了`,
      `${t.nextMoves}: ${t.kifuNoContinuation} (${t.kifuVariation})`,
      `${t.nextMoves}: ${t.kifuNextMoveUnavailable}`,
    ]);
    useServerKifuStore().searchByPosition.value = false;
    await flushPromises();
    expect(wrapper.findAll(".next-move")).toHaveLength(4);
    useServerKifuStore().lastExecutedSearch.value = { keyword: "non-position search" };
    await flushPromises();
    expect(wrapper.findAll(".next-move")).toHaveLength(0);
    wrapper.unmount();
  });

  it("opens statistics as a child dialog without closing or clearing the search", async () => {
    const state = useServerKifuStore();
    const wrapper = mountDialog();
    await flushPromises();
    const statisticsButton = () =>
      wrapper
        .findAll(".results-tools button")
        .find((button) => button.text() === t.showKifuStatistics)!;
    await statisticsButton().trigger("click");
    const dialog = wrapper.findComponent({ name: "KifuStatisticsDialog" });
    expect(dialog.exists()).toBe(true);
    expect(dialog.props("search")).toEqual(state.lastExecutedSearch.value);
    dialog.vm.$emit("close");
    await flushPromises();
    expect(wrapper.findComponent({ name: "KifuStatisticsDialog" }).exists()).toBe(false);
    expect(state.searchResults.value).toHaveLength(4);
    expect(closeModalDialog).not.toHaveBeenCalled();
    state.searchResultCount.value = 0;
    await flushPromises();
    expect(statisticsButton().attributes("disabled")).toBeDefined();
    state.searchResultCount.value = 4;
    state.lastExecutedSearch.value = undefined;
    await flushPromises();
    expect(statisticsButton().attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("passes the last executed search to batch analysis without using the displayed result subset", async () => {
    const state = useServerKifuStore();
    state.searchResultCount.value = 150;
    state.keyword.value = "not executed";
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper
      .findAll(".results-tools button")
      .find((button) => button.text() === t.batchAnalysis)!
      .trigger("click");
    expect(showBatchAnalysisDialog).toHaveBeenCalledWith({
      kind: "search",
      search: state.lastExecutedSearch.value,
    });
    expect(state.searchResults.value).toHaveLength(4);
    wrapper.unmount();
  });
});
