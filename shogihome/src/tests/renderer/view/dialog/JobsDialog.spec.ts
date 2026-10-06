import { flushPromises, shallowMount } from "@vue/test-utils";
import JobsDialog from "@/renderer/view/dialog/JobsDialog.vue";
import { Language } from "@/common/i18n/languages";
import type { JobSummary } from "@/common/jobs/types";
import { ApiResponseError } from "@/renderer/api/client";

const mocks = vi.hoisted(() => ({
  analysis: vi.fn(),
  games: vi.fn(),
  store: {
    canAttachJob: true,
    canDetachJob: false,
    attachJob: vi.fn(),
    detachJob: vi.fn(),
    closeJobsDialog: vi.fn(),
  },
}));
vi.mock("@/renderer/store", () => ({ useStore: () => mocks.store }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => ({ language: Language.JA }) }));
vi.mock("@/renderer/api/analysis_jobs", () => ({
  createAnalysisJobsClient: () => ({ list: mocks.analysis }),
}));
vi.mock("@/renderer/api/game_sessions", () => ({
  createGameSessionsClient: () => ({ list: mocks.games }),
}));

const job: JobSummary = {
  kind: "analysis",
  id: "job",
  requestId: "request",
  serverInstanceId: "server",
  state: "running",
  engines: ["Engine"],
  completed: 1,
  total: 3,
  attachment: { attached: false, epoch: 0 },
};
const mountDialog = () =>
  shallowMount(JobsDialog, {
    global: { stubs: { DialogFrame: { template: "<div><slot /></div>" } } },
  });

describe("JobsDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.store.canAttachJob = true;
    mocks.store.canDetachJob = false;
    mocks.analysis.mockResolvedValue([job]);
    mocks.games.mockResolvedValue([{ ...job, kind: "game", id: "game", state: "completed" }]);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows running and retained completed jobs with attachment and result actions", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.text()).toContain("実行中");
    expect(wrapper.text()).toContain("完了");
    expect(wrapper.text()).toContain("1 / 3");
    const actions = wrapper.findAll("li button");
    expect(actions[0].text()).toBe("アタッチ");
    expect(actions[1].text()).toBe("結果を開く");
    await actions[0].trigger("click");
    expect(mocks.store.attachJob).toHaveBeenCalledWith(job);
    wrapper.unmount();
    const calls = mocks.analysis.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.analysis).toHaveBeenCalledTimes(calls);
  });

  it("offers detachment but disables new attachments while the screen is occupied", async () => {
    mocks.store.canAttachJob = false;
    mocks.store.canDetachJob = true;
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.find("li button").attributes("disabled")).toBeDefined();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "デタッチ")!
      .trigger("click");
    expect(mocks.store.detachJob).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("honors Retry-After even when refresh is clicked manually", async () => {
    mocks.analysis.mockRejectedValueOnce(new ApiResponseError(429, "Rate limited", 30_000));
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toBe("Rate limited");
    expect(wrapper.text()).not.toContain("保持されているジョブはありません");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "更新")!
      .trigger("click");
    expect(mocks.analysis).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.analysis).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
