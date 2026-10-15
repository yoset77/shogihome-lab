import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SfenExportJobStatus } from "@/common/file/sfen_export";
import { ApiResponseError } from "@/renderer/api/client";
import { useServerKifuStore } from "@/renderer/store/serverKifu";
import SfenExportDialog from "@/renderer/view/dialog/SfenExportDialog.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";

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
    store.sfenExportStandardInitialOnly.value = false;
  });

  afterEach(() => {
    useServerKifuStore().sfenExportJob.value = undefined;
    useServerKifuStore().sfenExportStandardInitialOnly.value = false;
    vi.useRealTimers();
  });

  const mountDialog = () =>
    shallowMount(SfenExportDialog, {
      global: {
        stubs: {
          DialogFrame: { template: "<div><slot /></div>" },
          ToggleButton: false,
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

  it.each([false, true])(
    "starts an export using the edited persisted setting (initial=%s) and shows progress",
    async (initial) => {
      const store = useServerKifuStore();
      store.sfenExportStandardInitialOnly.value = initial;
      startExport.mockResolvedValue(status("queued"));
      getExport.mockResolvedValue(status("running"));
      const wrapper = mountDialog();
      const setting = wrapper.findAllComponents(ToggleButton)[0];
      expect((setting.find("input").element as HTMLInputElement).checked).toBe(initial);
      await setting.find("input").setValue(!initial);
      await wrapper.find(".settings input").setValue("selected");
      await wrapper.findAll(".main-buttons button")[1].trigger("click");
      await flushPromises();

      expect(startExport).toHaveBeenCalledWith({
        filename: "selected.sfen",
        search: { keyword: "target" },
        maxMoves: undefined,
        standardInitialOnly: !initial,
        overwrite: false,
      });
      expect(localStorage.getItem("serverKifuSfenExportStandardInitialOnly")).toBe(
        String(!initial),
      );
      expect(wrapper.find(".progress").exists()).toBe(true);
      expect(getExport).toHaveBeenCalledWith("job-1");
      wrapper.unmount();
    },
  );

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
    expect(wrapper.find(".progress").exists()).toBe(true);

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
