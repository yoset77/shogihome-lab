import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";

const mountSelector = (scroll = true) =>
  mount(HorizontalSelector, {
    props: {
      value: "pv",
      items: [
        { label: "PV", value: "pv" },
        { label: "Record", value: "record" },
      ],
      scroll,
    },
  });

enableAutoUnmount(afterEach);

describe("HorizontalSelector", () => {
  it.each([
    [-40, 80, 60],
    [280, 80, 160],
    [0, 80, 100],
    [220, 80, 100],
  ])("reveals the selected item at x=%i with width=%i", (left, width, expectedScrollLeft) => {
    const wrapper = mountSelector();
    const root = wrapper.element as HTMLElement;
    const selected = wrapper.get('input[value="pv"]').element.parentElement!;
    root.scrollLeft = 100;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 0, 300, 30));
    vi.spyOn(selected, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10 + left, 0, width, 30),
    );

    wrapper.vm.scrollToSelected();

    expect(root.scrollLeft).toBe(expectedScrollLeft);
    expect(wrapper.emitted("update:value")).toBeUndefined();
    expect((wrapper.get('input[value="pv"]').element as HTMLInputElement).checked).toBe(true);
  });

  it("does not scroll unless explicitly requested", async () => {
    const wrapper = mountSelector();
    const root = wrapper.element as HTMLElement;
    root.scrollLeft = 100;

    await wrapper.setProps({ value: "record" });

    expect(root.scrollLeft).toBe(100);
  });

  it("does not scroll when scrolling is disabled", () => {
    const wrapper = mountSelector(false);
    const root = wrapper.element as HTMLElement;
    root.scrollLeft = 100;
    const measure = vi.spyOn(root, "getBoundingClientRect");

    wrapper.vm.scrollToSelected();

    expect(root.scrollLeft).toBe(100);
    expect(measure).not.toHaveBeenCalled();
  });

  it("does not scroll when there is no selected item", async () => {
    const wrapper = mountSelector();
    const root = wrapper.element as HTMLElement;
    root.scrollLeft = 100;
    await wrapper.setProps({ value: "missing" });

    wrapper.vm.scrollToSelected();

    expect(root.scrollLeft).toBe(100);
  });
});
