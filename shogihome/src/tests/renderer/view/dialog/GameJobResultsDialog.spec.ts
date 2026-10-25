import { flushPromises, shallowMount } from "@vue/test-utils";
import GameJobResultsDialog from "@/renderer/view/dialog/GameJobResultsDialog.vue";
import { t } from "@/common/i18n";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  openJobRecordFile: vi.fn(),
  canAttachJob: true,
}));
vi.mock("@/renderer/store", () => ({ useStore: () => mocks }));
vi.mock("@/renderer/api/game_sessions", () => ({
  createGameSessionsClient: () => ({ snapshot: mocks.snapshot }),
}));
describe("parallel game record details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canAttachJob = true;
    mocks.snapshot.mockResolvedValue({
      records: [
        { gameId: "game_1", state: "saved", path: "game.kifu" },
        { gameId: "game_2", state: "unsaved" },
        { gameId: "game_3", state: "failed" },
      ],
    });
    mocks.openJobRecordFile.mockResolvedValue(true);
  });
  const mountDialog = () =>
    shallowMount(GameJobResultsDialog, {
      props: { jobId: "job" },
      global: { stubs: { DialogFrame: { template: "<div><slot /></div>" } } },
    });
  it("opens a saved file through the unsaved-record guard and explains history-only records", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(mocks.snapshot).toHaveBeenCalledWith("job");
    expect(wrapper.text()).toContain(t.parallelGameHistoryOnly);
    expect(wrapper.text()).toContain(t.gameSaveFailed);
    expect(wrapper.findAll("li button")).toHaveLength(1);
    await wrapper.get("li button").trigger("click");
    await flushPromises();
    expect(mocks.openJobRecordFile).toHaveBeenCalledWith("game.kifu", "game");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
  it("keeps details open when record replacement is declined", async () => {
    mocks.openJobRecordFile.mockResolvedValue(false);
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.get("li button").trigger("click");
    await flushPromises();
    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
  });
});
