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
const store = {
  appState: AppState.NORMAL,
  record: new Record(),
  appendMovesSilently: vi.fn(),
  appendSearchComment: vi.fn(),
};

enableAutoUnmount(afterEach);

describe.each([
  ["PC", PVPreviewDialog],
  ["mobile", PVPreviewDialogMobile],
] as const)("PVPreviewDialog (%s)", (_, component) => {
  let pv: Move[];
  let positions: string[];

  const mountDialog = async () => {
    const wrapper = shallowMount(component, {
      props: { position: store.record.position.clone(), pv },
      global: {
        stubs: {
          DialogFrame: { template: "<div><slot /></div>" },
          BoardView: {
            props: ["position", "lastMove"],
            template: '<div><slot name="right-control" /><slot name="left-control" /></div>',
          },
        },
      },
    });
    await nextTick();
    return wrapper;
  };

  beforeEach(() => {
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
    const buttons = (await mountDialog()).findAll(".move-element");
    expect(buttons).toHaveLength(pv.length);
    for (const button of buttons) {
      expect(button.element.tagName).toBe("BUTTON");
      expect(button.attributes("type")).toBe("button");
    }
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
