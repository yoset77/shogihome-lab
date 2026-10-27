import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import { t } from "@/common/i18n";
import FileSaveDialog from "@/renderer/view/dialog/FileSaveDialog.vue";
import ServerDirectoryPickerDialog from "@/renderer/view/dialog/ServerDirectoryPickerDialog.vue";
import BusyMessage from "@/renderer/view/dialog/BusyMessage.vue";
import ConfirmDialog from "@/renderer/view/dialog/ConfirmDialog.vue";
import { useBusyState } from "@/renderer/store/busy";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useFileSaveStore, type FileSaveOptions } from "@/renderer/store/fileSave";

const mocks = vi.hoisted(() => ({ list: vi.fn(), error: vi.fn() }));
vi.mock("@/renderer/ipc/api", () => ({ default: { listServerDirectories: mocks.list } }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.error }) }));

const options: FileSaveOptions = {
  title: t.saveToServer,
  defaultPath: "server://games/current.kif",
  server: true,
  extensions: [".kif", ".jkf"],
};
const press = (element: Element, key: string) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

describe("file save dialog", () => {
  const wrappers: VueWrapper[] = [];
  beforeAll(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
  });
  afterAll(() => Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"));
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockImplementation(async (path: string) => ({
      path,
      directories: path === "" ? [{ name: "games", path: "games" }] : [],
    }));
  });
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    useFileSaveStore().finish();
    useConfirmationStore().cancel();
    document.body.innerHTML = "";
    expect(useBusyState().isBusy).toBe(false);
  });
  const mountDialog = (overrides: Partial<FileSaveOptions> = {}) => {
    const wrapper = mount(FileSaveDialog, {
      props: { options: { ...options, ...overrides } },
      attachTo: document.body,
    });
    wrappers.push(wrapper);
    return wrapper;
  };

  it("edits the name and format without writing until the user confirms", async () => {
    const wrapper = mountDialog();
    const input = wrapper.get<HTMLInputElement>(".save-name input");
    expect(document.activeElement).toBe(input.element);
    expect(input.element.value).toBe("current");
    expect(input.element.selectionStart).toBe(input.element.value.length);
    expect(input.element.selectionEnd).toBe(input.element.value.length);
    await input.setValue("final");
    await wrapper.get("select").setValue(".jkf");
    expect(wrapper.get(".destination").text()).toBe("server://games/final.jkf");
    expect(wrapper.emitted("select")).toBeUndefined();
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("select")).toEqual([["server://games/final.jkf"]]);
  });

  it("uses a fixed extension without offering conversion", async () => {
    const wrapper = mountDialog({ defaultPath: "exports/engine.db", extensions: [".db"] });
    expect(wrapper.find("select").exists()).toBe(false);
    expect(wrapper.get(".extension").text()).toBe(".db");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("select")).toEqual([["server://exports/engine.db"]]);
  });

  it("does not offer server directories for a local download", async () => {
    const wrapper = mountDialog({ server: false, defaultPath: "local.kif" });
    expect(wrapper.find("fieldset").exists()).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled();
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("select")).toEqual([["local.kif"]]);
  });

  it("blocks invalid names and directory traversal even on form submission", async () => {
    const wrapper = mountDialog();
    await wrapper.get(".save-name input").setValue("../file");
    expect(wrapper.get<HTMLButtonElement>('[type="submit"]').element.disabled).toBe(true);
    expect(wrapper.get('[role="status"]').text()).toContain("../file");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("select")).toBeUndefined();
    await wrapper.get(".save-name input").setValue("valid");
    await wrapper.get("fieldset input").setValue("../games");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("select")).toBeUndefined();
    await wrapper.get("fieldset input").setValue("server://");
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("select")).toEqual([["server://valid.kif"]]);
  });

  it("reuses the directory picker and handles Enter and Escape only in the child", async () => {
    const wrapper = mountDialog();
    await wrapper.get("fieldset button").trigger("click");
    await flushPromises();
    let picker = wrapper.getComponent(ServerDirectoryPickerDialog);
    expect(picker.props("title")).toBe(t.saveDestination);
    expect(wrapper.get("dialog").element.contains(picker.element)).toBe(false);
    await picker.get(".breadcrumb-item").trigger("click");
    await flushPromises();
    press(picker.element, "Escape");
    await flushPromises();
    expect(wrapper.emitted("cancel")).toBeUndefined();
    expect(wrapper.emitted("select")).toBeUndefined();
    expect(wrapper.get(".destination").text()).toBe("server://games/current.kif");
    expect(document.activeElement).toBe(wrapper.get("fieldset button").element);

    await wrapper.get("fieldset button").trigger("click");
    await flushPromises();
    picker = wrapper.getComponent(ServerDirectoryPickerDialog);
    await picker.get(".breadcrumb-item").trigger("click");
    await flushPromises();
    press(picker.get('[data-hotkey="Enter"]').element, "Enter");
    await flushPromises();
    expect(wrapper.findComponent(ServerDirectoryPickerDialog).exists()).toBe(false);
    expect(wrapper.get(".destination").text()).toBe("server://current.kif");
    expect(wrapper.emitted("select")).toBeUndefined();
    press(wrapper.get('[data-hotkey="Enter"]').element, "Enter");
    await flushPromises();
    expect(wrapper.emitted("select")).toEqual([["server://current.kif"]]);
  });

  it("allows file input and asynchronous confirmation while a save holds the busy state", async () => {
    const host = defineComponent({
      components: { FileSaveDialog, BusyMessage, ConfirmDialog },
      setup: () => ({
        busy: useBusyState(),
        files: useFileSaveStore(),
        confirmation: useConfirmationStore(),
      }),
      template: `<BusyMessage v-if="busy.isBusy" />
        <ConfirmDialog v-if="confirmation.message" />
        <FileSaveDialog v-if="files.options" :key="files.id" :options="files.options"
          @select="files.finish($event)" @cancel="files.finish()" />`,
    });
    const wrapper = mount(host, { attachTo: document.body });
    wrappers.push(wrapper);
    const busy = useBusyState();
    busy.retain();
    try {
      const selection = useFileSaveStore().show(options);
      await flushPromises();
      expect(wrapper.findAll("dialog")).toHaveLength(2);
      expect(document.activeElement).toBe(wrapper.get(".save-name input").element);
      await wrapper.getComponent(FileSaveDialog).get("form").trigger("submit");
      await expect(selection).resolves.toBe("server://games/current.kif");
      expect(wrapper.findComponent(FileSaveDialog).exists()).toBe(false);
      const confirmed = useConfirmationStore().ask("Overwrite?");
      await flushPromises();
      const confirm = wrapper.getComponent(ConfirmDialog);
      press(confirm.get('[data-hotkey="Escape"]').element, "Escape");
      await expect(confirmed).resolves.toBe(false);
      expect(wrapper.findComponent(ConfirmDialog).exists()).toBe(false);
    } finally {
      busy.release();
    }
  });
});
