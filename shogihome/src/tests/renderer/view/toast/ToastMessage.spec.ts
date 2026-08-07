import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ToastMessage from "@/renderer/view/toast/ToastMessage.vue";
import { useToastStore } from "@/renderer/store/toast";

const originalUrl = window.location.href;

describe("ToastMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useToastStore().clear();
    document.body.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
    window.history.replaceState({}, "", originalUrl);
  });

  it("renders the toast type and dismisses it when activated", async () => {
    const store = useToastStore();
    store.success("Saved");
    const wrapper = mount(ToastMessage, {
      global: {
        stubs: { Icon: true },
      },
    });

    const toast = wrapper.get(".toast");
    expect(toast.classes()).toContain("toast-success");
    expect(toast.attributes("role")).toBe("status");
    await toast.trigger("click");
    expect(store.toasts).toHaveLength(0);
    wrapper.unmount();
  });

  it("uses alert semantics for warning notifications", () => {
    const store = useToastStore();
    store.warning("Connection lost");
    const wrapper = mount(ToastMessage, {
      global: {
        stubs: { Icon: true },
      },
    });

    expect(wrapper.get(".toast").attributes("role")).toBe("alert");
    wrapper.unmount();
  });

  it("ignores DOM changes unrelated to dialogs", async () => {
    const querySelectorAll = vi.spyOn(document, "querySelectorAll");
    const wrapper = mount(ToastMessage, {
      global: {
        stubs: { Icon: true },
      },
    });
    querySelectorAll.mockClear();

    const unrelatedElement = document.createElement("div");
    document.body.append(unrelatedElement);
    await new Promise((resolve) => window.setTimeout(resolve));

    expect(querySelectorAll).not.toHaveBeenCalled();
    unrelatedElement.remove();
    wrapper.unmount();
  });

  it("teleports toasts into an open dialog top layer", async () => {
    window.history.replaceState({}, "", "?mobile");
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);

    useToastStore().success("Saved");
    const wrapper = mount(ToastMessage, {
      global: {
        stubs: { Icon: true },
      },
    });
    await nextTick();

    expect(dialog.querySelector(".toast-success")).not.toBeNull();
    expect(dialog.querySelector(".toast-container")?.classList.contains("mobile-bottom")).toBe(
      false,
    );
    wrapper.unmount();
  });

  it("renders toasts in the document after the target dialog is removed", async () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    const wrapper = mount(ToastMessage, {
      attachTo: document.body,
      global: {
        stubs: { Icon: true },
      },
    });
    await nextTick();

    dialog.remove();
    await new Promise((resolve) => window.setTimeout(resolve));
    useToastStore().success("Saved");
    await nextTick();

    expect(dialog.querySelector(".toast-success")).toBeNull();
    expect(document.body.querySelector(".toast-success")).not.toBeNull();
    wrapper.unmount();
  });

  it("renders at most two toasts in the mobile layout", () => {
    window.history.replaceState({}, "", "?mobile");
    const store = useToastStore();
    store.info("one");
    store.info("two");
    store.info("three");

    const wrapper = mount(ToastMessage, {
      global: {
        stubs: { Icon: true },
      },
    });

    expect(wrapper.findAll(".toast")).toHaveLength(2);
    expect(wrapper.get(".toast-container").classes()).toContain("mobile-bottom");
    expect(wrapper.text()).not.toContain("one");
    expect(wrapper.text()).toContain("two");
    expect(wrapper.text()).toContain("three");
    wrapper.unmount();
  });
});
