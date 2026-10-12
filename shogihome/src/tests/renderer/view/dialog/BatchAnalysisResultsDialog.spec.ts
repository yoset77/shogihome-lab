import { flushPromises, mount } from "@vue/test-utils";
import { t } from "@/common/i18n";
import BatchAnalysisResultsDialog from "@/renderer/view/dialog/BatchAnalysisResultsDialog.vue";
const mocks = vi.hoisted(() => ({
  files: vi.fn(),
  openBatchAnalysisFile: vi.fn(),
  canAttachJob: true,
}));
vi.mock("@/renderer/api/analysis_jobs", () => ({
  createAnalysisJobsClient: () => ({ files: mocks.files }),
}));
vi.mock("@/renderer/store", () => ({ useStore: () => mocks }));
vi.mock("@/renderer/helpers/dialog", () => ({ showModalDialog: vi.fn() }));
describe("batch result file list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canAttachJob = true;
    mocks.files.mockResolvedValue([
      { index: 1, path: "saved.kifu", state: "saved" },
      { index: 2, path: "failed.kifu", state: "failed", reason: "changed" },
    ]);
    mocks.openBatchAnalysisFile.mockResolvedValue(true);
  });
  it("opens saved originals and shows localized failure reasons", async () => {
    const wrapper = mount(BatchAnalysisResultsDialog, { props: { jobId: "batch" } });
    await flushPromises();
    expect(mocks.files).toHaveBeenCalledWith("batch");
    expect(wrapper.text()).toContain(t.batchAnalysisReason("changed"));
    const open = wrapper.findAll("button").find((button) => button.text() === t.open)!;
    await open.trigger("click");
    await flushPromises();
    expect(mocks.openBatchAnalysisFile).toHaveBeenCalledWith("saved.kifu");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
  it("does not close the result list if opening is declined", async () => {
    mocks.openBatchAnalysisFile.mockResolvedValue(false);
    const wrapper = mount(BatchAnalysisResultsDialog, { props: { jobId: "batch" } });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === t.open)!
      .trigger("click");
    await flushPromises();
    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
  });
});
