import { shallowMount } from "@vue/test-utils";
import { Record } from "tsshogi";
import { vi } from "vitest";
import BookComparisonColumn from "@/renderer/view/main/BookComparisonColumn.vue";

vi.mock("@/renderer/store", () => ({
  useStore: () => ({
    record: new Record(),
    isMovableByUser: true,
  }),
}));

describe("BookComparisonColumn", () => {
  it("closes an inactive column", async () => {
    const wrapper = shallowMount(BookComparisonColumn, {
      props: {
        book: {
          sessionId: "first",
          path: "server://first.db",
          format: "yane2016",
          moves: [],
          closing: false,
          isUnsaved: false,
        },
        active: false,
      },
    });

    const closeButton = wrapper.get("header button");
    await closeButton.trigger("click");

    expect(wrapper.emitted("close")).toEqual([["first"]]);
    expect(wrapper.emitted("activate")).toBeUndefined();
    wrapper.unmount();
  });

  it("activates the column when its content is clicked", async () => {
    const wrapper = shallowMount(BookComparisonColumn, {
      props: {
        book: {
          sessionId: "first",
          path: "server://first.db",
          format: "yane2016",
          moves: [],
          closing: false,
          isUnsaved: false,
        },
        active: false,
      },
    });

    await wrapper.get("section").trigger("click");

    expect(wrapper.emitted("activate")).toEqual([["first"]]);
    wrapper.unmount();
  });

  it("emits an undefined session ID for a new book", async () => {
    const wrapper = shallowMount(BookComparisonColumn, {
      props: {
        book: {
          sessionId: undefined,
          path: undefined,
          format: "yane2016",
          moves: [],
          closing: false,
          isUnsaved: false,
        },
        active: false,
      },
    });

    await wrapper.get("section").trigger("click");
    await wrapper.get("header button").trigger("click");

    expect(wrapper.emitted("activate")).toEqual([[undefined]]);
    expect(wrapper.emitted("close")).toEqual([[undefined]]);
    wrapper.unmount();
  });
});
