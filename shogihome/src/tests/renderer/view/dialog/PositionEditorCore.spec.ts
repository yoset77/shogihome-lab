import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Color, InitialPositionSFEN, Piece, PieceType, Position, Square } from "tsshogi";
import { RectSize } from "@/common/assets/geometry";
import PositionEditorCore from "@/renderer/view/dialog/PositionEditorCore.vue";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import PieceBox from "@/renderer/view/primitive/PieceBox.vue";
import { BoardLayoutType } from "@/common/settings/layout";

vi.mock("@/renderer/store/settings", () => ({
  useAppSettings: () => ({
    boardImage: "default",
    boardImageFileURL: undefined,
    boardOpacity: 1,
    boardGridColor: "",
    pieceStandImage: "default",
    pieceStandImageFileURL: undefined,
    pieceStandOpacity: 1,
    enableTransparent: false,
    promotionSelectorStyle: "horizontal",
    boardLabelType: "standard",
    kingPieceType: "gyoku",
    enableDragAndDrop: true,
    pieceImage: "hitomoji",
  }),
}));

let resizeObserverCallback: ResizeObserverCallback;

const createWrapper = (position: Position, flip = false) =>
  mount(PositionEditorCore, {
    props: {
      position,
      layoutType: BoardLayoutType.PORTRAIT,
      ghostTeleportTarget: "#dialog",
      flip,
    },
    global: {
      stubs: {
        BoardView: {
          name: "BoardView",
          props: ["ghostTeleportTarget", "maxSize"],
          template: "<div />",
        },
        PieceBox: {
          name: "PieceBox",
          template: "<div />",
          methods: { containsPoint: () => true },
        },
      },
    },
  });

describe("PositionEditorCore", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  it("passes the native dialog target to BoardView", () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position);

    expect(wrapper.findComponent(BoardView).props("ghostTeleportTarget")).toBe("#dialog");
  });

  it("uses the measured board area without a fixed PieceBox height", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position);

    resizeObserverCallback(
      [{ contentRect: { width: 320, height: 480 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    await wrapper.vm.$nextTick();

    const maxSize = wrapper.findComponent(BoardView).props("maxSize") as RectSize;
    expect(maxSize.width).toBe(320);
    expect(maxSize.height).toBe(480);
  });

  it("adds the missing king color from PieceBox", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    position.board.set(new Square(5, 9), new Piece(Color.BLACK, PieceType.KING));
    const wrapper = createWrapper(position);

    wrapper.findComponent(BoardView).vm.$emit("pieceBoxDrop", PieceType.KING, new Square(5, 1));
    await wrapper.vm.$nextTick();

    const updated = wrapper.emitted<Position[]>("change")?.[0]?.[0];
    expect(updated?.board.at(new Square(5, 1))).toEqual(new Piece(Color.WHITE, PieceType.KING));
  });

  it("adds a non-king PieceBox piece for the near side regardless of the turn", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    position.setColor(Color.WHITE);
    const wrapper = createWrapper(position);

    wrapper.findComponent(BoardView).vm.$emit("pieceBoxDrop", PieceType.PAWN, new Square(5, 5));
    await wrapper.vm.$nextTick();

    const updated = wrapper.emitted<Position[]>("change")?.[0]?.[0];
    expect(updated?.board.at(new Square(5, 5))).toEqual(new Piece(Color.BLACK, PieceType.PAWN));
  });

  it("adds a non-king PieceBox piece for the near side on a flipped board", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position, true);

    wrapper.findComponent(BoardView).vm.$emit("pieceBoxDrop", PieceType.PAWN, new Square(5, 5));
    await wrapper.vm.$nextTick();

    const updated = wrapper.emitted<Position[]>("change")?.[0]?.[0];
    expect(updated?.board.at(new Square(5, 5))).toEqual(new Piece(Color.WHITE, PieceType.PAWN));
  });

  it("adds the first king for the near side when both kings are missing", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position, true);

    wrapper.findComponent(BoardView).vm.$emit("pieceBoxDrop", PieceType.KING, new Square(5, 5));
    await wrapper.vm.$nextTick();

    const updated = wrapper.emitted<Position[]>("change")?.[0]?.[0];
    expect(updated?.board.at(new Square(5, 5))).toEqual(new Piece(Color.WHITE, PieceType.KING));
  });

  it("rejects a PieceBox drop when no physical piece remains", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.STANDARD) as Position;
    const wrapper = createWrapper(position);

    wrapper.findComponent(BoardView).vm.$emit("pieceBoxDrop", PieceType.PAWN, new Square(5, 5));
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("adds a PieceBox piece to the selected hand", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position);

    wrapper.findComponent(BoardView).vm.$emit("pieceBoxDrop", PieceType.PAWN, Color.WHITE);
    await wrapper.vm.$nextTick();

    const updated = wrapper.emitted<Position[]>("change")?.[0]?.[0];
    expect(updated?.whiteHand.count(PieceType.PAWN)).toBe(1);
  });

  it("rejects placing a king in a hand", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position);

    wrapper.findComponent(BoardView).vm.$emit("pieceBoxDrop", PieceType.KING, Color.BLACK);
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("moves a selected board piece back to PieceBox by tapping", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const square = new Square(5, 5);
    position.board.set(square, new Piece(Color.BLACK, PieceType.PAWN));
    const wrapper = createWrapper(position);

    wrapper.findComponent(BoardView).vm.$emit("editSelectionChange", square);
    wrapper.findComponent(PieceBox).vm.$emit("tapDrop");
    await wrapper.vm.$nextTick();

    const updated = wrapper.emitted<Position[]>("change")?.[0]?.[0];
    expect(updated?.board.at(square)).toBeNull();
  });

  it("clears a board selection when the viewpoint flips", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const square = new Square(5, 5);
    position.board.set(square, new Piece(Color.BLACK, PieceType.PAWN));
    const wrapper = createWrapper(position);

    wrapper.findComponent(BoardView).vm.$emit("editSelectionChange", square);
    await wrapper.vm.$nextTick();
    await wrapper.setProps({ flip: true });
    wrapper.findComponent(PieceBox).vm.$emit("tapDrop");
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("change")).toBeUndefined();
  });
});
