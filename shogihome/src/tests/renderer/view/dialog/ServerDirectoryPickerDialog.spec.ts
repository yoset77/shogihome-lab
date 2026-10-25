import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import ServerDirectoryPickerDialog from "@/renderer/view/dialog/ServerDirectoryPickerDialog.vue";
import GameSaveDirectory from "@/renderer/view/dialog/GameSaveDirectory.vue";
import DialogFrame from "@/renderer/view/dialog/DialogFrame.vue";
import type { ServerDirectoryList } from "@/common/file/upload";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  error: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/renderer/ipc/api", () => ({ default: { listServerDirectories: mocks.list } }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.error }) }));

describe("server directory picker dialog", () => {
  const wrappers: VueWrapper[] = [];
  beforeAll(() => {
    // jsdom does not implement native modal dialogs.
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
    document.body.innerHTML = "";
  });
  const mountDialog = (initialPath = "") => {
    const wrapper = mount(ServerDirectoryPickerDialog, {
      props: { initialPath },
      attachTo: document.body,
    });
    wrappers.push(wrapper);
    return wrapper;
  };
  const confirm = (wrapper: Pick<VueWrapper, "get">) =>
    wrapper.get<HTMLButtonElement>('[data-hotkey="Enter"]');
  const press = (element: Element, key: string) =>
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  it("navigates without committing, then selects the displayed folder", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.get(".directory-path").text()).toBe("server://");
    const games = wrapper
      .findAll(".server-selection-item")
      .find((entry) => entry.text() === "games")!;
    await games.get(".entry-header").trigger("click");
    await flushPromises();
    expect(mocks.list).toHaveBeenLastCalledWith("games");
    expect(wrapper.get(".directory-path").text()).toBe("server://games");
    expect(wrapper.emitted("select")).toBeUndefined();
    await confirm(wrapper).trigger("click");
    expect(wrapper.emitted("select")).toEqual([["games"]]);
  });

  it("selects the root only on explicit confirmation", async () => {
    const wrapper = mountDialog("games");
    await flushPromises();
    expect(mocks.list).toHaveBeenCalledWith("games");
    await wrapper.get(".breadcrumb-item").trigger("click");
    await flushPromises();
    expect(wrapper.get(".directory-path").text()).toBe("server://");
    expect(wrapper.emitted("select")).toBeUndefined();
    await confirm(wrapper).trigger("click");
    expect(wrapper.emitted("select")).toEqual([[""]]);
  });

  it("does not confirm before a listing succeeds, or after it fails", async () => {
    const pending = Promise.withResolvers<ServerDirectoryList>();
    mocks.list.mockReturnValueOnce(pending.promise);
    const wrapper = mountDialog("missing");
    expect(confirm(wrapper).element.disabled).toBe(true);
    press(wrapper.element, "Enter");
    expect(wrapper.emitted("select")).toBeUndefined();
    pending.reject(new Error("Directory removed"));
    await flushPromises();
    expect(confirm(wrapper).element.disabled).toBe(true);
    expect(wrapper.emitted("select")).toBeUndefined();
    await wrapper.get(".breadcrumb-item").trigger("click");
    await flushPromises();
    expect(confirm(wrapper).element.disabled).toBe(false);
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("discards requests completed after the dialog is unmounted", async () => {
    const pending = Promise.withResolvers<ServerDirectoryList>();
    mocks.list.mockReturnValueOnce(pending.promise);
    const wrapper = mountDialog();
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    pending.reject(new Error("Cancelled request"));
    await flushPromises();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("does not steal focus when a superseded initial listing finishes", async () => {
    const initial = Promise.withResolvers<ServerDirectoryList>();
    mocks.list.mockReturnValueOnce(initial.promise);
    const wrapper = mountDialog("games");
    await wrapper.get(".breadcrumb-item").trigger("click");
    await flushPromises();
    const cancel = wrapper.get<HTMLButtonElement>('[data-hotkey="Escape"]');
    cancel.element.focus();
    initial.resolve({ path: "games", directories: [] });
    await flushPromises();
    expect(wrapper.get(".directory-path").text()).toBe("server://");
    expect(document.activeElement).toBe(cancel.element);
  });

  const mountParent = () => {
    const parent = defineComponent({
      components: { DialogFrame, GameSaveDirectory },
      setup: () => ({ value: ref("server://games"), start: mocks.start, cancel: mocks.cancel }),
      template: `<DialogFrame @cancel="cancel">
        <GameSaveDirectory v-model:value="value" :disabled="false" />
        <button data-hotkey="Enter" @click="start">Start</button>
        <button data-hotkey="Escape" @click="cancel">Cancel</button>
      </DialogFrame>`,
    });
    const wrapper = mount(parent, { attachTo: document.body });
    wrappers.push(wrapper);
    return wrapper;
  };

  it("Escape cancels only the child dialog and restores the selection button focus", async () => {
    const wrapper = mountParent();
    const field = wrapper.getComponent(GameSaveDirectory);
    await field.get("button").trigger("click");
    await flushPromises();
    const picker = wrapper.getComponent(ServerDirectoryPickerDialog);
    expect(wrapper.get("dialog").element.contains(picker.element)).toBe(false);
    await picker.get(".breadcrumb-item").trigger("click");
    await flushPromises();
    press(picker.element, "Escape");
    await flushPromises();
    expect(wrapper.findComponent(ServerDirectoryPickerDialog).exists()).toBe(false);
    expect(field.props("value")).toBe("server://games");
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field.get("button").element);
  });

  it("Enter confirms only the child and reinstalls the parent's hotkeys after closing", async () => {
    const wrapper = mountParent();
    const field = wrapper.getComponent(GameSaveDirectory);
    const pending = Promise.withResolvers<ServerDirectoryList>();
    mocks.list.mockReturnValueOnce(pending.promise);
    await field.get("button").trigger("click");
    const picker = wrapper.getComponent(ServerDirectoryPickerDialog);
    press(picker.element, "Enter");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(wrapper.findComponent(ServerDirectoryPickerDialog).exists()).toBe(true);
    pending.resolve({ path: "games", directories: [] });
    await flushPromises();
    await picker.get(".breadcrumb-item").trigger("click");
    await flushPromises();
    press(confirm(picker).element, "Enter");
    await flushPromises();
    expect(wrapper.findComponent(ServerDirectoryPickerDialog).exists()).toBe(false);
    expect(field.props("value")).toBe("server://");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field.get("button").element);
    press(wrapper.get('[data-hotkey="Enter"]').element, "Enter");
    expect(mocks.start).toHaveBeenCalledOnce();
  });
});
