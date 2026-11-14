import { mount, shallowMount } from "@vue/test-utils";
import { Move, Record } from "tsshogi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordView from "@/renderer/view/primitive/RecordView.vue";
import BranchPopup from "@/renderer/view/primitive/BranchPopup.vue";
import { BranchListMode } from "@/common/settings/app";

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

function mockListGeometry(itemTop = 220, height = 100) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = this.classList.contains("selected") ? itemTop : 100;
    const elementHeight = this.classList.contains("selected") ? 20 : height;
    return { top, bottom: top + elementHeight, height: elementHeight } as DOMRect;
  });
}

describe("RecordView", () => {
  let resizeObserverCallback: ResizeObserverCallback;
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    observe.mockClear();
    unobserve.mockClear();
    disconnect.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback;
        }
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("allows read-only browsing while disabling branch reordering", async () => {
    const wrapper = mount(RecordView, {
      props: { record: buildBranchRecord(), operational: true, editable: false, shortcutKeys },
    });
    await wrapper.findAll(".move-list .move-element")[1].trigger("click");
    expect(wrapper.emitted("selectMove")?.[0]).toEqual([1]);
    await wrapper.findAll(".control button")[0].trigger("click");
    expect(wrapper.emitted("goBegin")).toHaveLength(1);
    const buttons = wrapper.findAll(".branch-side-control button");
    expect(buttons.every((button) => (button.element as HTMLButtonElement).disabled)).toBe(true);
    await buttons[0].trigger("click");
    expect(wrapper.emitted("swapWithPreviousBranch")).toBeUndefined();
    wrapper.unmount();
  });

  it("scrolls the selected move into view when mounted", () => {
    mockListGeometry();

    const record = new Record();
    const firstMove = record.position.createMoveByUSI("7g7f");
    const secondMove = record.position.createMoveByUSI("3c3d");
    if (!firstMove || !secondMove) throw new Error("Failed to create test moves");
    record.append(firstMove);
    record.append(secondMove);
    record.goto(2);

    const wrapper = shallowMount(RecordView, {
      props: {
        record,
        operational: false,
        showTopControl: false,
        showBottomControl: false,
        showBranches: false,
        shortcutKeys,
      },
    });

    expect(wrapper.get(".move-list").element.scrollTop).toBe(40);
    wrapper.unmount();
  });

  it.each([
    { top: 80, expected: 70 },
    { top: 220, expected: 150 },
    { top: 140, expected: 100 },
  ])("scrolls only its list when the selected row is at $top", async ({ top, expected }) => {
    mockListGeometry(top);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    parent.scrollTop = 25;
    const wrapper = shallowMount(RecordView, {
      props: { record: buildBranchRecord(), shortcutKeys, showBranches: false },
      attachTo: parent,
    });
    const list = wrapper.get(".move-list").element as HTMLElement;
    const selected = wrapper.get(".move-list .selected").element as HTMLElement;
    selected.style.scrollMarginTop = "10px";
    selected.style.scrollMarginBottom = "10px";
    list.scrollTop = 100;
    await wrapper.setProps({ showElapsedTime: true });
    expect(list.scrollTop).toBe(expected);
    expect(parent.scrollTop).toBe(25);
    wrapper.unmount();
  });

  it("does not measure or scroll a hidden list", () => {
    const bounds = mockListGeometry(220, 0);
    const wrapper = shallowMount(RecordView, {
      props: { record: buildBranchRecord(), shortcutKeys },
    });
    expect(bounds).not.toHaveBeenCalled();
    expect(wrapper.get(".move-list").element.scrollTop).toBe(0);
    wrapper.unmount();
  });

  it("limits the surrounding margin when the list barely fits one row", async () => {
    mockListGeometry(100, 24);
    const wrapper = shallowMount(RecordView, {
      props: { record: buildBranchRecord(), shortcutKeys },
      attachTo: document.body,
    });
    const selected = wrapper.get(".move-list .selected").element as HTMLElement;
    selected.style.scrollMarginTop = "16px";
    selected.style.scrollMarginBottom = "16px";
    const list = wrapper.get(".move-list").element;
    list.scrollTop = 50;
    await wrapper.setProps({ showElapsedTime: true });
    expect(list.scrollTop).toBe(48);
    wrapper.unmount();
  });

  it("scrolls the selected sibling branch within the branch list", () => {
    mockListGeometry();
    const wrapper = shallowMount(RecordView, {
      props: { record: buildBranchRecord(), shortcutKeys },
    });
    expect(wrapper.get(".branch-list").element.scrollTop).toBe(40);
    wrapper.unmount();
  });

  it("keeps the selection visible when a list resizes and disconnects on unmount", async () => {
    mockListGeometry();
    const wrapper = shallowMount(RecordView, {
      props: { record: buildBranchRecord(), shortcutKeys },
    });
    const moves = wrapper.get(".move-list").element;
    const branches = wrapper.get(".branch-list").element;
    expect(observe).toHaveBeenCalledWith(moves);
    expect(observe).toHaveBeenCalledWith(branches);
    moves.scrollTop = 0;
    branches.scrollTop = 0;
    resizeObserverCallback([], {} as ResizeObserver);
    expect(moves.scrollTop).toBe(40);
    expect(branches.scrollTop).toBe(40);
    await wrapper.setProps({ showBranches: false });
    expect(unobserve).toHaveBeenCalledWith(branches);
    await wrapper.setProps({ showBranches: true });
    expect(observe).toHaveBeenCalledWith(wrapper.get(".branch-list").element);
    wrapper.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("scrolls a next-move branch after selecting it", async () => {
    mockListGeometry();
    const record = buildBranchRecord();
    record.goto(1);
    const wrapper = shallowMount(RecordView, {
      props: { record, shortcutKeys, operational: true, branchListMode: BranchListMode.NEXT_MOVE },
    });
    expect(wrapper.get(".branch-list").element.scrollTop).toBe(0);
    await wrapper.get(".branch-list .move-element").trigger("click");
    expect(wrapper.get(".branch-list").element.scrollTop).toBe(40);
    wrapper.unmount();
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
    mockListGeometry();
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
    const list = wrapper.get(".move-list").element;
    list.scrollTop = 0;

    const rows = wrapper.findAll(".move-list .move-element");
    await rows[2].trigger("contextmenu", { clientX: 100, clientY: 120 });

    expect(wrapper.findComponent(BranchPopup).exists()).toBe(true);
    resizeObserverCallback([], {} as ResizeObserver);
    // Opening the popup must not scroll the list and immediately close the popup.
    expect(list.scrollTop).toBe(0);
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
