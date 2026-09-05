import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_UPLOAD_ACCEPT } from "@/common/file/upload";
import ServerFileUploadDialog from "@/renderer/view/dialog/ServerFileUploadDialog.vue";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  destroy: vi.fn(),
  retain: vi.fn(),
  release: vi.fn(),
  addError: vi.fn(),
  showConfirmation: vi.fn(),
  showToast: vi.fn(),
  listDirectories: vi.fn(),
  uploadFiles: vi.fn(),
}));

vi.mock("@/renderer/store", () => ({
  useStore: () => ({ closeModalDialog: mocks.close, destroyModalDialog: mocks.destroy }),
}));
vi.mock("@/renderer/store/busy", () => ({
  useBusyState: () => ({ retain: mocks.retain, release: mocks.release }),
}));
vi.mock("@/renderer/store/error", () => ({
  useErrorStore: () => ({ add: mocks.addError }),
}));
vi.mock("@/renderer/store/confirm", () => ({
  useConfirmationStore: () => ({ show: mocks.showConfirmation }),
}));
vi.mock("@/renderer/store/toast", () => ({
  useToastStore: () => ({ success: mocks.showToast }),
}));
vi.mock("@/renderer/store/serverFileUpload", () => ({
  listUploadDirectories: mocks.listDirectories,
  uploadServerFiles: mocks.uploadFiles,
}));

const mountDialog = () =>
  shallowMount(ServerFileUploadDialog, {
    global: {
      stubs: {
        DialogFrame: { template: "<div><slot /></div>" },
        Icon: true,
      },
    },
  });

describe("ServerFileUploadDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDirectories.mockResolvedValue({
      path: "",
      directories: [{ name: "books", path: "books" }],
    });
  });

  it("supports multiple files and lists existing destination directories", async () => {
    const wrapper = mountDialog();
    await flushPromises();

    const input = wrapper.find<HTMLInputElement>('input[type="file"]');
    expect(input.attributes("multiple")).toBeDefined();
    expect(input.attributes("accept")).toBe(SERVER_UPLOAD_ACCEPT);
    expect(wrapper.text()).toContain("books");
    expect(mocks.listDirectories).toHaveBeenCalledWith("");
  });

  it("retries only conflicting files after confirmation", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const files = [new File(["new"], "new.kif"), new File(["old"], "old.db")];
    const input = wrapper.find<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input.element, "files", { configurable: true, value: files });
    await input.trigger("change");
    mocks.uploadFiles.mockResolvedValueOnce({
      uploaded: [{ path: "new.kif" }],
      conflicts: [files[1]],
      errors: [],
    });
    mocks.uploadFiles.mockResolvedValueOnce({
      uploaded: [{ path: "old.db" }],
      conflicts: [],
      errors: [],
    });

    await wrapper.find("button.upload").trigger("click");
    await flushPromises();

    expect(mocks.uploadFiles).toHaveBeenNthCalledWith(1, files, "");
    const confirmation = mocks.showConfirmation.mock.calls[0][0];
    await confirmation.onOk();
    await flushPromises();
    expect(mocks.uploadFiles).toHaveBeenNthCalledWith(2, [files[1]], "", true);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.showToast).toHaveBeenCalledOnce();
  });

  it("lists selected files and removes them individually", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const files = [new File(["a"], "a.kif"), new File(["b"], "b.db")];
    const input = wrapper.find<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input.element, "files", { configurable: true, value: files });
    await input.trigger("change");

    expect(wrapper.find(".file-list").text()).toContain("a.kif");
    expect(wrapper.find(".file-list").text()).toContain("b.db");
    expect(wrapper.text()).toContain("Root");
    expect(wrapper.text()).not.toContain("KIFU_DIR");

    await wrapper.findAll(".file .remove")[1].trigger("click");
    expect(wrapper.find(".file-list").text()).toContain("a.kif");
    expect(wrapper.find(".file-list").text()).not.toContain("b.db");
  });
});
