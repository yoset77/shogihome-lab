import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { Move, Position, Record } from "tsshogi";
import { AppState } from "@/common/control/state";
import { defaultAppSettings } from "@/common/settings/app";
import PVPreviewDialog from "@/renderer/view/dialog/PVPreviewDialog.vue";
import PVPreviewDialogMobile from "@/renderer/view/dialog/PVPreviewDialogMobile.vue";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import { getRecordShortcutKeys } from "@/renderer/view/primitive/board/shortcut";
import type { USIPVEnd } from "@/common/game/usi";

const { useStore, useAppSettings } = vi.hoisted(() => ({
  useStore: vi.fn(),
  useAppSettings: vi.fn(),
}));

vi.mock("@/renderer/store", () => ({ useStore }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings }));
vi.mock("@/renderer/store/toast", () => ({
  useToastStore: () => ({ success: vi.fn() }),
}));

const settings = reactive(defaultAppSettings());
let resizeObserverCallback: ResizeObserverCallback;
const observe = vi.fn();
const disconnect = vi.fn();
const store = {
  appState: AppState.NORMAL,
  record: new Record(),
  appendMovesSilently: vi.fn(),
  appendSearchComment: vi.fn(),
};

enableAutoUnmount(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  ["PC", PVPreviewDialog],
  ["mobile", PVPreviewDialogMobile],
] as const)("PVPreviewDialog (%s)", (_, component) => {
  let pv: Move[];
  let positions: string[];

  const mountDialog = async (pvEnd?: USIPVEnd) => {
    const wrapper = shallowMount(component, {
      props: { position: store.record.position.clone(), pv, pvEnd },
      global: {
        stubs: {
          DialogFrame: { template: "<div><slot /></div>" },
          BoardView: {
            props: ["position", "lastMove", "maxSize"],
            template: '<div><slot name="right-control" /><slot name="left-control" /></div>',
          },
        },
      },
    });
    await nextTick();
    return wrapper;
  };

  beforeEach(() => {
    observe.mockClear();
    disconnect.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    Object.assign(settings, defaultAppSettings());
    store.appState = AppState.NORMAL;
    store.record = new Record();
    store.appendMovesSilently.mockReset();
    store.appendSearchComment.mockReset();
    useStore.mockReturnValue(store);
    useAppSettings.mockReturnValue(settings);

    const record = new Record();
    pv = [];
    positions = [record.position.sfen];
    for (const usi of ["7g7f", "3c3d", "2g2f", "8c8d"]) {
      const move = record.position.createMoveByUSI(usi) as Move;
      expect(record.append(move)).toBe(true);
      pv.push(move);
      positions.push(record.position.sfen);
    }
  });

  it.runIf(component === PVPreviewDialog)(
    "keeps the border-box width on mount, observer updates, and height-only resizes",
    async () => {
      vi.stubGlobal("innerWidth", 500);
      vi.stubGlobal("innerHeight", 800);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        return new DOMRect(0, 0, this.classList.contains("informations") ? 400 : 0, 120);
      });
      const wrapper = await mountDialog();
      const board = wrapper.getComponent(BoardView);
      expect(board.props("maxSize").width).toBe(400);

      resizeObserverCallback(
        [
          {
            target: wrapper.get(".informations").element,
            contentRect: new DOMRect(0, 0, 385, 120),
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
      await nextTick();
      expect(board.props("maxSize").width).toBe(400);

      vi.stubGlobal("innerHeight", 900);
      window.dispatchEvent(new Event("resize"));
      await nextTick();
      expect(board.props("maxSize").width).toBe(400);
      expect(board.props("maxSize").height).toBe(640);
    },
  );

  it.runIf(component === PVPreviewDialog)(
    "fits the board to the information area on narrow screens",
    async () => {
      const wrapper = await mountDialog();
      const information = wrapper.get(".informations").element;
      expect(observe).toHaveBeenCalledWith(information, { box: "border-box" });
      const bounds = vi.spyOn(information, "getBoundingClientRect");
      const board = wrapper.getComponent(BoardView);
      const height = board.props("maxSize").height;
      for (const width of [242, 294, 0, 400, window.innerWidth]) {
        bounds.mockReturnValue(new DOMRect(0, 0, width, 120));
        resizeObserverCallback(
          [
            {
              target: information,
              contentRect: new DOMRect(0, 0, width, 120),
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
        await nextTick();
        expect(board.props("maxSize").width).toBe(Math.min(window.innerWidth * 0.8, width || 294));
        expect(board.props("maxSize").height).toBe(height);
      }
      wrapper.unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    },
  );

  it.each([0, 1, 3])(
    "jumps to the position after PV move %i without changing the main record",
    async (index) => {
      const wrapper = await mountDialog();
      const mainSFEN = store.record.position.sfen;
      if (index === 0) {
        const shortcuts = getRecordShortcutKeys(settings.recordShortcutKeys);
        await wrapper.get(`[data-hotkey="${shortcuts.End}"]`).trigger("click");
      }
      await wrapper.findAll(".move-element")[index].trigger("click");

      const board = wrapper.getComponent(BoardView);
      expect((board.props("position") as Position).sfen).toBe(positions[index + 1]);
      expect((board.props("lastMove") as Move).usi).toBe(pv[index].usi);
      expect(wrapper.findAll(".move-element.selected")).toHaveLength(1);
      expect(wrapper.findAll(".move-element")[index].classes()).toContain("selected");
      expect(wrapper.findAll(".move-element")[index].attributes("aria-current")).toBe("step");
      expect(store.record.position.sfen).toBe(mainSFEN);
      expect(store.record.current.ply).toBe(0);
      expect(store.record.moves).toHaveLength(1);
      expect(store.appendMovesSilently).not.toHaveBeenCalled();
      expect(store.appendSearchComment).not.toHaveBeenCalled();
    },
  );

  it("uses native buttons so PV moves are keyboard accessible", async () => {
    const wrapper = await mountDialog();
    expect(wrapper.find(".pv-end").exists()).toBe(false);
    const buttons = wrapper.findAll(".move-element");
    expect(buttons).toHaveLength(pv.length);
    for (const button of buttons) {
      expect(button.element.tagName).toBe("BUTTON");
      expect(button.attributes("type")).toBe("button");
    }
  });

  it.each([
    ["rep_draw", "千日手"],
    ["rep_win", "連続王手の千日手"],
    ["rep_lose", "連続王手の千日手"],
    ["rep_sup", "優等局面"],
    ["rep_inf", "劣等局面"],
    ["win", "宣言勝ち"],
    ["resign", "投了"],
  ] as const)("displays %s as a non-interactive annotation, not a move", async (end, label) => {
    const wrapper = await mountDialog(end);
    const annotation = wrapper.get(".pv-end");
    expect(annotation.element.tagName).toBe("SPAN");
    expect(annotation.element.textContent).toBe(` （${label}）`);
    expect(annotation.attributes("tabindex")).toBeUndefined();
    expect(annotation.attributes("role")).toBeUndefined();
    expect(annotation.element.previousElementSibling).toBe(
      wrapper.findAll(".move-element").at(-1)!.element,
    );
    expect(wrapper.findAll(".move-element")).toHaveLength(pv.length);

    const shortcuts = getRecordShortcutKeys(settings.recordShortcutKeys);
    await wrapper.get(`[data-hotkey="${shortcuts.End}"]`).trigger("click");
    await wrapper.get(`[data-hotkey="${shortcuts.Forward}"]`).trigger("click");
    const board = wrapper.getComponent(BoardView);
    expect((board.props("position") as Position).sfen).toBe(positions[4]);
    expect((board.props("lastMove") as Move).usi).toBe(pv[3].usi);
    expect(wrapper.findAll(".move-element.selected")).toHaveLength(1);
    expect(wrapper.findAll(".move-element")[3].classes()).toContain("selected");
    expect(store.record.current.ply).toBe(0);
  });

  it("keeps the annotation out of record and comment insertions", async () => {
    const wrapper = await mountDialog("rep_draw");
    store.appendMovesSilently.mockReturnValue(pv.length);
    const buttons = wrapper.findAll(".control-item-wide");
    await buttons[0].trigger("click");
    expect(store.appendMovesSilently).toHaveBeenCalledExactlyOnceWith(pv, {
      ignoreValidation: true,
    });
    await buttons[1].trigger("click");
    const info = store.appendSearchComment.mock.lastCall?.[1];
    expect(info.pv).toEqual(pv);
    expect(info).not.toHaveProperty("pvEnd");
  });

  it("updates or removes the annotation without resetting the selected move", async () => {
    const wrapper = await mountDialog("rep_draw");
    await wrapper.findAll(".move-element")[2].trigger("click");
    await wrapper.setProps({ pvEnd: "rep_sup" });
    expect(wrapper.get(".pv-end").text()).toBe("（優等局面）");
    expect(wrapper.findAll(".move-element")[2].classes()).toContain("selected");
    await wrapper.setProps({ pvEnd: undefined });
    expect(wrapper.find(".pv-end").exists()).toBe(false);
  });

  it("can display just an annotation without creating a move", async () => {
    pv = [];
    const wrapper = await mountDialog("resign");
    expect(wrapper.get(".pv-end").element.textContent).toBe("（投了）");
    expect(wrapper.findAll(".move-element")).toHaveLength(0);
    expect(wrapper.getComponent(BoardView).props("lastMove")).toBeNull();
  });

  it("keeps previous, next, beginning and end controls working after a jump", async () => {
    const wrapper = await mountDialog();
    const shortcuts = getRecordShortcutKeys(settings.recordShortcutKeys);
    await wrapper.findAll(".move-element")[2].trigger("click");
    const board = wrapper.getComponent(BoardView);

    await wrapper.get(`[data-hotkey="${shortcuts.Back}"]`).trigger("click");
    expect((board.props("position") as Position).sfen).toBe(positions[2]);
    await wrapper.get(`[data-hotkey="${shortcuts.Forward}"]`).trigger("click");
    expect((board.props("position") as Position).sfen).toBe(positions[3]);
    await wrapper.get(`[data-hotkey="${shortcuts.Begin}"]`).trigger("click");
    expect((board.props("position") as Position).sfen).toBe(positions[0]);
    expect(wrapper.findAll(".move-element.selected")).toHaveLength(0);
    await wrapper.get(`[data-hotkey="${shortcuts.End}"]`).trigger("click");
    expect((board.props("position") as Position).sfen).toBe(positions[4]);
    expect(wrapper.findAll(".move-element")[3].classes()).toContain("selected");
  });
});
