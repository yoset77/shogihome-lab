import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Record } from "tsshogi";
import ShareDialog from "@/renderer/view/dialog/ShareDialog.vue";

const closeModalDialog = vi.hoisted(() => vi.fn());
const addError = vi.hoisted(() => vi.fn());
const showSuccessToast = vi.hoisted(() => vi.fn());

vi.mock("@/renderer/store", () => ({
  useStore: () => ({ record: new Record(), closeModalDialog }),
}));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: addError }) }));
vi.mock("@/renderer/store/toast", () => ({
  useToastStore: () => ({ success: showSuccessToast }),
}));
vi.mock("@/renderer/ipc/api", () => ({ default: { openWebBrowser: vi.fn() } }));

const mountDialog = () =>
  shallowMount(ShareDialog, {
    global: {
      stubs: {
        DialogFrame: { template: "<div><slot /></div>" },
        Icon: true,
      },
    },
  });

describe("ShareDialog", () => {
  beforeEach(() => {
    closeModalDialog.mockReset();
    addError.mockReset();
    showSuccessToast.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("notifies when a URL is copied", async () => {
    const wrapper = mountDialog();

    await wrapper.find("button.action").trigger("click");
    await flushPromises();

    expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
    expect(showSuccessToast).toHaveBeenCalledOnce();
    expect(addError).not.toHaveBeenCalled();
  });

  it("reports copy failures without a success toast", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error("denied"));
    const wrapper = mountDialog();

    await wrapper.find("button.action").trigger("click");
    await flushPromises();

    expect(addError).toHaveBeenCalledOnce();
    expect(showSuccessToast).not.toHaveBeenCalled();
  });
});
