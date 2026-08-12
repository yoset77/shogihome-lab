import { readFileSync } from "node:fs";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SfenExportJobStatus } from "@/common/file/sfen_export";
import { ApiResponseError } from "@/renderer/api/client";
import { useServerKifuStore } from "@/renderer/store/serverKifu";
import SfenExportDialog from "@/renderer/view/dialog/SfenExportDialog.vue";

const startExport = vi.hoisted(() => vi.fn());
const getExport = vi.hoisted(() => vi.fn());
const cancelExport = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn());
const addError = vi.hoisted(() => vi.fn());

vi.mock("@/renderer/ipc/api", () => ({
  default: {
    startServerKifuSfenExport: startExport,
    getServerKifuSfenExport: getExport,
    cancelServerKifuSfenExport: cancelExport,
  },
}));
vi.mock("@/renderer/store/message", () => ({ useMessageStore: () => ({ enqueue }) }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: addError }) }));

describe("SfenExportDialog", () => {
  const source = readFileSync("src/renderer/view/dialog/SfenExportDialog.vue", "utf-8");

  beforeEach(() => {
    vi.useFakeTimers();
    startExport.mockReset();
    getExport.mockReset();
    cancelExport.mockReset();
    enqueue.mockReset();
    addError.mockReset();
    const store = useServerKifuStore();
    store.lastExecutedSearch.value = { keyword: "target" };
    store.sfenExportJob.value = undefined;
  });

  afterEach(() => {
    useServerKifuStore().sfenExportJob.value = undefined;
    vi.useRealTimers();
  });

  const mountDialog = () =>
    shallowMount(SfenExportDialog, {
      global: {
        stubs: {
          DialogFrame: { template: "<div><slot /></div>" },
          ToggleButton: { template: "<button />" },
        },
      },
    });

  const status = (state: SfenExportJobStatus["state"], extra = {}): SfenExportJobStatus => ({
    jobId: "job-1",
    state,
    outputPath: "result.sfen",
    totalFiles: 2,
    processedFiles: state === "completed" ? 2 : 0,
    exportedLines: 1,
    failedFiles: 0,
    ...extra,
  });

  it("shows progress immediately and polls frequently", () => {
    expect(source).toContain("const POLL_INTERVAL_MS = 250");
    expect(source).toContain("showProgress.value = true");
    expect(source).toContain('<template v-if="showProgress">');
    expect(source).not.toContain("PROGRESS_DELAY_MS");
  });

  it("supports resuming an active export after reopening", () => {
    expect(source).toContain("if (isRunning.value)");
    expect(source).toContain("poll();");
  });

  it("uses the shared dialog form-group style", () => {
    expect(source).toContain('class="settings form-group column"');
    expect(source).toContain('class="progress form-group column"');
  });

  it("uses the persisted standard-initial-position setting", () => {
    expect(source).toContain('v-model:value="sfenExportStandardInitialOnly"');
    expect(source).not.toContain("const standardInitialOnly = ref(false)");
  });

  it("reports partial exports instead of unconditional success", () => {
    expect(source).toContain("sfenExportCompletedWithWarnings");
    expect(source).toContain("job.value.failedFiles > 0");
    expect(source).not.toContain("job.value.failedFiles > 0 ||");
  });

  it("recovers polling after transient errors and clears expired jobs", () => {
    expect(source).toContain("schedulePoll(getPollRetryDelay())");
    expect(source).toContain("e.status === 404");
    expect(source).toContain("job.value = undefined");
    expect(source).toContain("schedulePoll(0)");
  });

  it("retries a transient polling failure and reports a partial completion", async () => {
    const store = useServerKifuStore();
    store.sfenExportJob.value = status("running");
    getExport
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(status("running"))
      .mockResolvedValueOnce(status("completed", { failedFiles: 1 }));

    const wrapper = mountDialog();
    await flushPromises();
    expect(getExport).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(getExport).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(getExport).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledWith({
      text: expect.stringContaining("1件の棋譜を変換できませんでした。"),
    });
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("clears an expired job and returns to the export settings", async () => {
    const store = useServerKifuStore();
    store.sfenExportJob.value = status("running");
    getExport.mockRejectedValue(new ApiResponseError(404, "not found"));

    const wrapper = mountDialog();
    await flushPromises();

    expect(addError).toHaveBeenCalled();
    expect(store.sfenExportJob.value).toBeUndefined();
    expect(wrapper.find(".settings").exists()).toBe(true);
    wrapper.unmount();
  });

  it("continues polling after cancellation until the job is terminal", async () => {
    const store = useServerKifuStore();
    store.sfenExportJob.value = status("running");
    getExport.mockResolvedValueOnce(status("running")).mockResolvedValueOnce(status("cancelled"));
    cancelExport.mockResolvedValue(undefined);

    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.findAll("button")[0].trigger("click");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(cancelExport).toHaveBeenCalledWith("job-1");
    expect(getExport).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("checks the terminal state when cancellation races with completion", async () => {
    const store = useServerKifuStore();
    store.sfenExportJob.value = status("running");
    getExport.mockResolvedValueOnce(status("running")).mockResolvedValueOnce(status("completed"));
    cancelExport.mockRejectedValue(new ApiResponseError(404, "not running"));

    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.findAll("button")[0].trigger("click");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(getExport).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalled();
    expect(addError).not.toHaveBeenCalled();
    expect(wrapper.emitted("completed")).toHaveLength(1);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});
