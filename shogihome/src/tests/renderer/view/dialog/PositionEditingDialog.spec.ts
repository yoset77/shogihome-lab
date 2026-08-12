import { shallowMount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Color,
  exportBOD,
  InitialPositionSFEN,
  Piece,
  PieceType,
  Position,
  Record,
  Square,
} from "tsshogi";
import PositionEditingDialog from "@/renderer/view/dialog/PositionEditingDialog.vue";
import PositionEditorCore from "@/renderer/view/dialog/PositionEditorCore.vue";
import { BoardLayoutType } from "@/common/settings/layout";

const closePositionEditingDialog = vi.hoisted(() => vi.fn());
const addError = vi.hoisted(() => vi.fn());
const showSuccessToast = vi.hoisted(() => vi.fn());
const isMobileWebApp = vi.hoisted(() => vi.fn(() => false));
const store = vi.hoisted(() => ({
  record: { position: null as unknown as Position },
  closePositionEditingDialog,
}));

vi.mock("@/renderer/store", () => ({ useStore: () => store }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: addError }) }));
vi.mock("@/renderer/store/toast", () => ({
  useToastStore: () => ({ success: showSuccessToast }),
}));
vi.mock("@/renderer/ipc/api", () => ({ isMobileWebApp }));

const mountDialog = () =>
  shallowMount(PositionEditingDialog, {
    global: {
      stubs: {
        DialogFrame: { template: "<div><slot /></div>" },
        InitialPositionMenu: true,
      },
    },
  });

describe("PositionEditingDialog", () => {
  beforeEach(() => {
    closePositionEditingDialog.mockReset();
    addError.mockReset();
    showSuccessToast.mockReset();
    isMobileWebApp.mockReturnValue(false);
    store.record.position = Position.newBySFEN(InitialPositionSFEN.STANDARD) as Position;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn().mockResolvedValue(""),
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("uses the dedicated desktop and mobile shells", () => {
    const desktop = mountDialog();
    expect(desktop.find(".desktop-dialog").exists()).toBe(true);
    expect(desktop.find(".mobile-shell").exists()).toBe(false);

    isMobileWebApp.mockReturnValue(true);
    const mobile = mountDialog();
    expect(mobile.find(".mobile-shell").exists()).toBe(true);
    expect(mobile.find(".desktop-dialog").exists()).toBe(false);
  });

  it("uses the standard board layout with a top toolbar on desktop", () => {
    const wrapper = mountDialog();
    const core = wrapper.findComponent(PositionEditorCore);
    expect(core.props("layoutType")).toBe(BoardLayoutType.STANDARD);
    expect(wrapper.find(".desktop-toolbar").exists()).toBe(true);
  });

  it("does not use inline sizing feedback on desktop", () => {
    const wrapper = mountDialog();
    expect(wrapper.find(".desktop-dialog").attributes("style")).toBeUndefined();
  });

  it("uses the portrait board layout on mobile", () => {
    isMobileWebApp.mockReturnValue(true);
    const wrapper = mountDialog();
    const core = wrapper.findComponent(PositionEditorCore);
    expect(core.props("layoutType")).toBe(BoardLayoutType.PORTRAIT);
  });

  it("keeps both toolbars text-only", () => {
    isMobileWebApp.mockReturnValue(true);
    const mobile = mountDialog();
    expect(mobile.find(".mobile-toolbar").findAllComponents({ name: "Icon" })).toHaveLength(0);

    isMobileWebApp.mockReturnValue(false);
    const desktop = mountDialog();
    expect(desktop.find(".desktop-toolbar").findAllComponents({ name: "Icon" })).toHaveLength(0);
  });

  it("shows all mobile actions without a disclosure", () => {
    isMobileWebApp.mockReturnValue(true);
    const wrapper = mountDialog();
    expect(wrapper.find(".mobile-toolbar").findAll("button")).toHaveLength(8);
    expect(wrapper.find('[data-test="more-actions"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="paste"]').exists()).toBe(true);
  });

  it("flips the board locally without changing the position", async () => {
    const wrapper = mountDialog();
    const core = wrapper.findComponent(PositionEditorCore);
    const originalSFEN = store.record.position.sfen;
    expect(core.props("flip")).toBe(false);

    await wrapper.find('[data-test="flip-board"]').trigger("click");

    expect(core.props("flip")).toBe(true);
    expect(store.record.position.sfen).toBe(originalSFEN);
    expect(closePositionEditingDialog).not.toHaveBeenCalled();
  });

  it("keeps edits in local undo and redo history", async () => {
    const wrapper = mountDialog();
    const edited = store.record.position.clone();
    edited.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.PAWN));

    wrapper.findComponent(PositionEditorCore).vm.$emit("change", edited);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="undo"]').attributes("disabled")).toBeUndefined();

    await wrapper.find('[data-test="undo"]').trigger("click");
    await wrapper.find('[data-test="ok"]').trigger("click");
    expect(closePositionEditingDialog).toHaveBeenLastCalledWith(InitialPositionSFEN.STANDARD);

    await wrapper.find('[data-test="redo"]').trigger("click");
    await wrapper.find('[data-test="ok"]').trigger("click");
    expect(closePositionEditingDialog).toHaveBeenLastCalledWith(edited.sfen);
  });

  it("discards the redo branch after a new edit", async () => {
    const wrapper = mountDialog();
    const firstEdit = store.record.position.clone();
    firstEdit.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.PAWN));
    wrapper.findComponent(PositionEditorCore).vm.$emit("change", firstEdit);
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="undo"]').trigger("click");

    const secondEdit = store.record.position.clone();
    secondEdit.board.set(new Square(4, 5), new Piece(Color.BLACK, PieceType.GOLD));
    wrapper.findComponent(PositionEditorCore).vm.$emit("change", secondEdit);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test="redo"]').attributes("disabled")).toBeDefined();
  });

  it("cancels without returning a position", async () => {
    const wrapper = mountDialog();
    await wrapper.find('[data-test="cancel"]').trigger("click");
    expect(closePositionEditingDialog).toHaveBeenCalledWith();
  });

  it("pastes a valid SFEN into the sandbox", async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValue(InitialPositionSFEN.HANDICAP_ROOK);
    const wrapper = mountDialog();

    await wrapper.find('[data-test="paste"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="ok"]').trigger("click");

    expect(closePositionEditingDialog).toHaveBeenCalledWith(InitialPositionSFEN.HANDICAP_ROOK);
  });

  it("round-trips a BOD position through paste", async () => {
    const handicap = Position.newBySFEN(InitialPositionSFEN.HANDICAP_BISHOP) as Position;
    vi.mocked(navigator.clipboard.readText).mockResolvedValue(exportBOD(new Record(handicap)));
    const wrapper = mountDialog();

    await wrapper.find('[data-test="paste"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="ok"]').trigger("click");

    expect(closePositionEditingDialog).toHaveBeenCalledWith(InitialPositionSFEN.HANDICAP_BISHOP);
  });

  it("accepts KIF headers with an ASCII colon", async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValue("手合割:角落ち");
    const wrapper = mountDialog();

    await wrapper.find('[data-test="paste"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="ok"]').trigger("click");

    expect(closePositionEditingDialog).toHaveBeenCalledWith(InitialPositionSFEN.HANDICAP_BISHOP);
  });

  it("reports clipboard access failures", async () => {
    vi.mocked(navigator.clipboard.readText).mockRejectedValue(new Error("denied"));
    const wrapper = mountDialog();

    await wrapper.find('[data-test="paste"]').trigger("click");
    await flushPromises();

    expect(addError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
  });

  it("reports clipboard write failures", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error("denied"));
    const wrapper = mountDialog();

    await wrapper.find('[data-test="copy-sfen"]').trigger("click");
    await flushPromises();

    expect(addError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  it("notifies when a position is copied", async () => {
    const wrapper = mountDialog();

    await wrapper.find('[data-test="copy-sfen"]').trigger("click");
    await flushPromises();

    expect(showSuccessToast).toHaveBeenCalledOnce();
  });

  it("rejects malformed clipboard text", async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValue("not a position");
    const wrapper = mountDialog();

    await wrapper.find('[data-test="paste"]').trigger("click");
    await flushPromises();

    expect(addError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    expect(closePositionEditingDialog).not.toHaveBeenCalled();
  });
});
