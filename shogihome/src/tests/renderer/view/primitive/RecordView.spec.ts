import { shallowMount } from "@vue/test-utils";
import { Record } from "tsshogi";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecordView from "@/renderer/view/primitive/RecordView.vue";

describe("RecordView", () => {
  const scrollIntoView = vi.fn();

  afterEach(() => {
    scrollIntoView.mockReset();
  });

  it("scrolls the selected move into view when mounted", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const record = new Record();
    const firstMove = record.position.createMoveByUSI("7g7f");
    const secondMove = record.position.createMoveByUSI("3c3d");
    if (!firstMove || !secondMove) throw new Error("Failed to create test moves");
    record.append(firstMove);
    record.append(secondMove);
    record.goto(2);

    shallowMount(RecordView, {
      props: {
        record,
        operational: false,
        showTopControl: false,
        showBottomControl: false,
        showBranches: false,
        shortcutKeys: {
          Begin: "Home",
          Back: "ArrowLeft",
          Forward: "ArrowRight",
          End: "End",
        },
      },
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "nearest" });
  });
});
