import { shallowMount } from "@vue/test-utils";
import { Record } from "tsshogi";
import { vi } from "vitest";
import BookComparisonColumn from "@/renderer/view/main/BookComparisonColumn.vue";
import BookView from "@/renderer/view/primitive/BookView.vue";

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

  it("includes its book session in row operation events", () => {
    const book = {
      sessionId: undefined,
      path: undefined,
      format: "yane2016" as const,
      moves: [],
      closing: false,
      isUnsaved: false,
    };
    const move = new Record().position.createMoveByUSI("7g7f")!;
    const wrapper = shallowMount(BookComparisonColumn, {
      props: { book, active: false },
    });
    const bookView = wrapper.getComponent(BookView);

    bookView.vm.$emit("edit", move);
    bookView.vm.$emit("remove", move);
    bookView.vm.$emit("order", move, 1);

    expect(wrapper.emitted("edit")).toEqual([[book, move]]);
    expect(wrapper.emitted("remove")).toEqual([[book, move]]);
    expect(wrapper.emitted("order")).toEqual([[book, move, 1]]);
    wrapper.unmount();
  });
});
