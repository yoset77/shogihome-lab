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
    canDetachListedJob: vi.fn(),
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
  createdAt: 1000,
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
    mocks.store.canDetachListedJob.mockImplementation(
      (candidate: JobSummary) =>
        mocks.store.canDetachJob &&
        candidate.attachment.attached &&
        candidate.kind === job.kind &&
        candidate.id === job.id &&
        candidate.serverInstanceId === job.serverInstanceId,
    );
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
    expect(wrapper.text()).toContain("1 / 3 手");
    expect(wrapper.text()).not.toContain("アタッチ中");
    expect(wrapper.text()).not.toContain("デタッチ中");
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
  it("shows the file progress of a background batch in games", async () => {
    mocks.analysis.mockResolvedValue([
      {
        ...job,
        completed: 2,
        total: 10,
        batch: {
          totalFiles: 10,
          processedFiles: 2,
          successTotal: 1,
          failedTotal: 1,
          skippedTotal: 0,
          currentFile: 3,
          currentPath: "games/current.kifu",
          recordIndex: 3,
          recordPath: "games/current.kifu",
          saved: false,
        },
      },
    ]);
    mocks.games.mockResolvedValue([]);
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.text()).toContain("2 / 10 局");
    wrapper.unmount();
  });

  it("offers detachment but disables new attachments while the screen is occupied", async () => {
    mocks.store.canAttachJob = false;
    mocks.store.canDetachJob = true;
    mocks.analysis.mockResolvedValue([{ ...job, attachment: { attached: true, epoch: 1 } }]);
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

  it("offers the detach action only on the attached job row", async () => {
    mocks.store.canAttachJob = false;
    mocks.store.canDetachJob = true;
    const detached: JobSummary = { ...job, id: "detached" };
    const attached: JobSummary = {
      ...job,
      id: "attached",
      attachment: { attached: true, epoch: 1 },
    };
    mocks.store.canDetachListedJob.mockImplementation(
      (candidate: JobSummary) => candidate.id === attached.id,
    );
    mocks.analysis.mockResolvedValue([detached, attached]);
    mocks.games.mockResolvedValue([]);
    const wrapper = mountDialog();
    await flushPromises();
    const rows = wrapper.findAll("li");
    expect(rows).toHaveLength(2);
    const detachButtons = rows.map((row) =>
      row.findAll("button").filter((button) => button.text() === "デタッチ"),
    );
    expect(detachButtons[0]).toHaveLength(0);
    expect(detachButtons[1]).toHaveLength(1);
    await rows[1]
      .findAll("button")
      .find((button) => button.text() === "デタッチ")!
      .trigger("click");
    expect(mocks.store.detachJob).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it.each(["analysis", "game"] as const)(
    "only detaches this screen's %s job when other screens also have attachments",
    async (kind) => {
      mocks.store.canAttachJob = false;
      mocks.store.canDetachJob = true;
      const current: JobSummary = {
        ...job,
        kind,
        engines: ["Current Engine"],
        attachment: { attached: true, epoch: 1 },
      };
      const otherJobs: JobSummary[] = [
        { ...current, id: "other-job", engines: ["Other Engine"] },
        { ...current, kind: kind === "analysis" ? "game" : "analysis", engines: ["Other Engine"] },
        { ...current, serverInstanceId: "other-server", engines: ["Other Engine"] },
      ];
      const jobs = [current, ...otherJobs];
      mocks.analysis.mockResolvedValue(jobs.filter((candidate) => candidate.kind === "analysis"));
      mocks.games.mockResolvedValue(jobs.filter((candidate) => candidate.kind === "game"));
      mocks.store.canDetachListedJob.mockImplementation(
        (candidate: JobSummary) =>
          candidate.kind === current.kind &&
          candidate.id === current.id &&
          candidate.serverInstanceId === current.serverInstanceId,
      );
      const wrapper = mountDialog();
      await flushPromises();
      const rows = wrapper.findAll("li");
      const detachButtons = (row: (typeof rows)[number]) =>
        row.findAll("button").filter((button) => button.text() === "デタッチ");
      expect(rows).toHaveLength(4);
      for (const row of rows.filter((row) => row.text().includes("Other Engine"))) {
        expect(detachButtons(row)).toHaveLength(0);
        expect(row.text()).not.toContain("アタッチ中");
        expect(row.text()).not.toContain("デタッチ中");
      }
      const currentRow = rows.find((row) => row.text().includes("Current Engine"))!;
      expect(detachButtons(currentRow)).toHaveLength(1);
      expect(currentRow.text()).toContain("アタッチ中");
      expect(currentRow.text()).not.toContain("デタッチ中");
      await detachButtons(currentRow)[0].trigger("click");
      expect(mocks.store.detachJob).toHaveBeenCalledExactlyOnceWith(current);
      wrapper.unmount();
    },
  );

  it("orders jobs by creation time across kinds", async () => {
    const oldAnalysis: JobSummary = { ...job, id: "old-analysis", createdAt: 1000 };
    const newGame: JobSummary = {
      ...job,
      kind: "game",
      id: "new-game",
      createdAt: 2000,
    };
    mocks.analysis.mockResolvedValue([oldAnalysis]);
    mocks.games.mockResolvedValue([newGame]);
    const wrapper = mountDialog();
    await flushPromises();
    const rows = wrapper.findAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("エンジン対局");
    expect(rows[1].text()).toContain("棋譜解析");
    wrapper.unmount();
  });

  it("keeps the action buttons outside the scrollable job list", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const scroll = wrapper.find(".scroll");
    const buttons = wrapper.find(".main-buttons");
    expect(scroll.exists()).toBe(true);
    expect(buttons.exists()).toBe(true);
    // The list scrolls inside the frame, so the buttons must not scroll away with it.
    expect(scroll.element.contains(buttons.element)).toBe(false);
    expect(
      scroll.element.compareDocumentPosition(buttons.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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
