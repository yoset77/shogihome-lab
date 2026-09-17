import { mount, shallowMount } from "@vue/test-utils";
import { Move, Record } from "tsshogi";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecordView from "@/renderer/view/primitive/RecordView.vue";
import BranchPopup from "@/renderer/view/primitive/BranchPopup.vue";

const shortcutKeys = {
  Begin: "Home",
  Back: "ArrowLeft",
  Forward: "ArrowRight",
  End: "End",
};

function buildBranchRecord(): Record {
  const record = new Record();
  const firstMove = record.position.createMoveByUSI("7g7f");
  const secondMove = record.position.createMoveByUSI("3c3d");
  if (!firstMove || !secondMove) throw new Error("Failed to create test moves");
  record.append(firstMove);
  record.append(secondMove);
  record.goto(1);
  const branchMove = record.position.createMoveByUSI("8c8d");
  if (!branchMove) throw new Error("Failed to create test moves");
  record.append(branchMove);
  return record;
}

describe("RecordView", () => {
  const scrollIntoView = vi.fn();

  afterEach(() => {
    scrollIntoView.mockReset();
    document.body.innerHTML = "";
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
        shortcutKeys,
      },
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "nearest" });
  });

  it("opens a branch popup on right-click when branches exist", async () => {
    const record = buildBranchRecord();
    // Active path: root -> 7g7f -> 8c8d. Right-click the ply=2 row.
    const wrapper = mount(RecordView, {
      props: {
        record,
        operational: true,
        showTopControl: false,
        showBottomControl: false,
        showBranches: false,
        shortcutKeys,
      },
      attachTo: document.body,
    });

    const rows = wrapper.findAll(".move-list .move-element");
    expect(rows.length).toBe(3);
    await rows[2].trigger("contextmenu", { clientX: 100, clientY: 120 });

    const popup = wrapper.findComponent(BranchPopup);
    expect(popup.exists()).toBe(true);
    expect(popup.props("branches").map((node) => (node.move as Move).usi)).toStrictEqual([
      "3c3d",
      "8c8d",
    ]);
    // The right-clicked move (8c8d, branchIndex 1) is highlighted.
    expect(popup.props("selectedBranchIndex")).toBe(record.current.branchIndex);
    // The selected branch is marked with a check, others are not.
    // NOTE: BranchPopup renders via Teleport to body, so query the document.
    const popupRows = Array.from(document.body.querySelectorAll(".branch-popup .move-element"));
    expect(popupRows.length).toBe(2);
    expect(popupRows[0].querySelector(".check")?.textContent).toBe("");
    expect(popupRows[1].querySelector(".check")?.textContent).toBe("✓");
    wrapper.unmount();
  });

  it("emits selectBranchNode when a branch is selected in the popup", async () => {
    const record = buildBranchRecord();
    const wrapper = mount(RecordView, {
      props: {
        record,
        operational: true,
        showTopControl: false,
        showBottomControl: false,
        showBranches: false,
        shortcutKeys,
      },
      attachTo: document.body,
    });

    const rows = wrapper.findAll(".move-list .move-element");
    await rows[2].trigger("contextmenu", { clientX: 100, clientY: 120 });

    const popup = wrapper.findComponent(BranchPopup);
    expect(popup.exists()).toBe(true);
    const mainBranch = popup.props("branches")[0];
    await popup.vm.$emit("select", mainBranch);

    expect(wrapper.emitted("selectBranchNode")).toHaveLength(1);
    expect(wrapper.emitted("selectBranchNode")?.[0][0]).toBe(mainBranch);
    // The popup closes after selection.
    expect(wrapper.findComponent(BranchPopup).exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not open a popup on right-click when there are no branches", async () => {
    const record = buildBranchRecord();
    const wrapper = mount(RecordView, {
      props: {
        record,
        operational: true,
        showTopControl: false,
        showBottomControl: false,
        showBranches: false,
        shortcutKeys,
      },
      attachTo: document.body,
    });

    const rows = wrapper.findAll(".move-list .move-element");
    // ply=1 (7g7f) has no siblings.
    await rows[1].trigger("contextmenu", { clientX: 100, clientY: 120 });

    expect(wrapper.findComponent(BranchPopup).exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not auto-scroll when opening the branch popup", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const record = buildBranchRecord();
    const wrapper = mount(RecordView, {
      props: {
        record,
        operational: true,
        showTopControl: false,
        showBottomControl: false,
        showBranches: false,
        shortcutKeys,
      },
      attachTo: document.body,
    });
    // Ignore the initial scroll on mount.
    scrollIntoView.mockClear();

    const rows = wrapper.findAll(".move-list .move-element");
    await rows[2].trigger("contextmenu", { clientX: 100, clientY: 120 });

    expect(wrapper.findComponent(BranchPopup).exists()).toBe(true);
    // Opening the popup must not trigger scrollIntoView, otherwise the list
    // scrolls to the current position and the popup closes immediately.
    expect(scrollIntoView).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not close the popup on scroll inside it, but closes on outside scroll", async () => {
    const record = buildBranchRecord();
    const wrapper = mount(RecordView, {
      props: {
        record,
        operational: true,
        showTopControl: false,
        showBottomControl: false,
        showBranches: false,
        shortcutKeys,
      },
      attachTo: document.body,
    });

    const rows = wrapper.findAll(".move-list .move-element");
    await rows[2].trigger("contextmenu", { clientX: 100, clientY: 120 });

    const popup = wrapper.findComponent(BranchPopup);
    expect(popup.exists()).toBe(true);

    // NOTE: BranchPopup renders via Teleport to body, so dispatch real DOM events.
    const popupEl = document.body.querySelector(".branch-popup");
    expect(popupEl).not.toBeNull();
    popupEl?.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(popup.emitted("close")).toBeUndefined();

    document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(popup.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});
