import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color, InitialPositionSFEN, Piece, PieceType, Position, Square } from "tsshogi";
import { RectSize } from "@/common/assets/geometry";
import PositionEditorCore from "@/renderer/view/dialog/PositionEditorCore.vue";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import PieceBox from "@/renderer/view/primitive/PieceBox.vue";
import { pieceBoxSize } from "@/renderer/view/primitive/pieceBoxLayout";
import { BoardLayoutType } from "@/common/settings/layout";

vi.mock("@/renderer/store/settings", () => ({
  useAppSettings: () => ({
    boardImage: "default",
    boardOpacity: 1,
    boardGridColor: "",
    pieceStandImage: "default",
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
const observe = vi.fn();
const disconnect = vi.fn();

const createWrapper = (
  position: Position,
  flip = false,
  layoutType: BoardLayoutType = BoardLayoutType.PORTRAIT,
) =>
  mount(PositionEditorCore, {
    props: {
      position,
      layoutType,
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
          props: ["scale", "mobile"],
          template: "<div />",
          methods: { containsPoint: () => true },
        },
      },
    },
  });

describe("PositionEditorCore", () => {
  afterEach(() => vi.unstubAllGlobals());

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
  });

  it("passes the native dialog target to BoardView", () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position);

    expect(wrapper.findComponent(BoardView).props("ghostTeleportTarget")).toBe("#dialog");
  });

  it("applies a capture sequence to one clone and publishes a single change", async () => {
    const position = new Position();
    const originalSFEN = position.sfen;
    const wrapper = createWrapper(position);
    const from = new Square(8, 8);
    const to = new Square(8, 3);

    wrapper
      .findComponent(BoardView)
      .vm.$emit("edit", [{ move: { from: to, to: Color.BLACK } }, { move: { from, to } }]);
    await wrapper.vm.$nextTick();

    const events = wrapper.emitted<[Position]>("change");
    expect(events).toHaveLength(1);
    expect(events![0][0].sfen).toBe(
      "lnsgkgsnl/1r5b1/pBppppppp/9/9/9/PPPPPPPPP/7R1/LNSGKGSNL b P 1",
    );
    expect(position.sfen).toBe(originalSFEN);
    wrapper.unmount();
  });

  it.each([false, true])("passes mobile=%s to PieceBox", async (mobile) => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position);
    await wrapper.setProps({ mobile });

    expect(wrapper.findComponent(PieceBox).props("mobile")).toBe(mobile);
  });

  it("hides the initial layout until a nonzero editor area is measured", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position);
    expect(wrapper.find(".editor-layout").classes()).toContain("pending");
    expect(observe).toHaveBeenCalledWith(wrapper.find(".editor-area").element);

    for (const [width, height] of [
      [0, 480],
      [320, 0],
    ]) {
      resizeObserverCallback(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      await wrapper.vm.$nextTick();
      expect(wrapper.find(".editor-layout").classes()).toContain("pending");
    }

    resizeObserverCallback(
      [{ contentRect: { width: 320, height: 480 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".editor-layout").classes()).not.toContain("pending");
    wrapper.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it.each([BoardLayoutType.STANDARD, BoardLayoutType.PORTRAIT])(
    "fits the entire %s layout using one board and PieceBox scale",
    async (layoutType) => {
      const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
      const wrapper = createWrapper(position, false, layoutType);
      const baseBoardSize = wrapper.findComponent(BoardView).props("maxSize") as RectSize;
      const baseWidth = Math.max(baseBoardSize.width, pieceBoxSize.width);
      const baseHeight = baseBoardSize.height + 8 + pieceBoxSize.height;
      const area = wrapper.find(".editor-area").element as HTMLElement;
      expect(area.style.aspectRatio).toBe(`${baseWidth} / ${baseHeight}`);

      // Cover width/height limits, rotation, and scales outside the former clamps.
      for (const [width, height] of [
        [320, 480],
        [844, 220],
        [1400, 700],
        [2400, 1800],
      ]) {
        resizeObserverCallback(
          [{ contentRect: { width, height } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
        await wrapper.vm.$nextTick();

        const scale = Math.min(width / baseWidth, height / baseHeight);
        const boardSize = wrapper.findComponent(BoardView).props("maxSize") as RectSize;
        expect(wrapper.findComponent(PieceBox).props("scale")).toBeCloseTo(scale);
        expect(boardSize.width).toBeCloseTo(baseBoardSize.width * scale);
        expect(boardSize.height).toBeCloseTo(baseBoardSize.height * scale);
        expect(area.style.aspectRatio).toBe(`${baseWidth} / ${baseHeight}`);
        const layout = wrapper.find(".editor-layout").element as HTMLElement;
        expect(parseFloat(layout.style.width)).toBeCloseTo(baseWidth * scale);
        expect(parseFloat(layout.style.height)).toBeCloseTo(baseHeight * scale);
        expect(parseFloat(layout.style.gap)).toBeCloseTo(8 * scale);
      }
      wrapper.unmount();
    },
  );

  it("keeps the board and PieceBox ratio fixed across one-pixel resizes", async () => {
    const position = Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;
    const wrapper = createWrapper(position, false, BoardLayoutType.STANDARD);

    resizeObserverCallback(
      [{ contentRect: { width: 1400, height: 700 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    await wrapper.vm.$nextTick();
    const scale = wrapper.findComponent(PieceBox).props("scale") as number;
    const boardSize = wrapper.findComponent(BoardView).props("maxSize") as RectSize;

    resizeObserverCallback(
      [{ contentRect: { width: 1400, height: 699 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    await wrapper.vm.$nextTick();

    const resizedScale = wrapper.findComponent(PieceBox).props("scale") as number;
    const resizedBoardSize = wrapper.findComponent(BoardView).props("maxSize") as RectSize;
    expect(resizedScale).toBeLessThan(scale);
    expect(resizedBoardSize.width / resizedScale).toBeCloseTo(boardSize.width / scale);
    expect(resizedBoardSize.height / resizedScale).toBeCloseTo(boardSize.height / scale);
    wrapper.unmount();
  });

  it("preserves the last valid measurement while its tab is hidden", async () => {
    const wrapper = createWrapper(new Position());
    resizeObserverCallback(
      [{ contentRect: { width: 320, height: 480 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    await wrapper.vm.$nextTick();
    const boardSize = wrapper.findComponent(BoardView).props("maxSize");

    resizeObserverCallback(
      [{ contentRect: { width: 0, height: 0 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(BoardView).props("maxSize")).toBe(boardSize);
    wrapper.unmount();
  });

  it("does not update the layout for an unchanged editor area", async () => {
    const wrapper = createWrapper(new Position());
    const entries = [{ contentRect: { width: 800, height: 700 } } as ResizeObserverEntry];
    resizeObserverCallback(entries, {} as ResizeObserver);
    await wrapper.vm.$nextTick();
    const boardSize = wrapper.findComponent(BoardView).props("maxSize");

    resizeObserverCallback(entries, {} as ResizeObserver);
    await wrapper.vm.$nextTick();

    expect(wrapper.findComponent(BoardView).props("maxSize")).toBe(boardSize);
    wrapper.unmount();
  });

  it("refits the same editor area when the board layout changes", async () => {
    const wrapper = createWrapper(new Position());
    resizeObserverCallback(
      [{ contentRect: { width: 800, height: 700 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    await wrapper.vm.$nextTick();
    await wrapper.setProps({ layoutType: BoardLayoutType.STANDARD });

    const boardSize = wrapper.findComponent(BoardView).props("maxSize") as RectSize;
    expect(boardSize.width).toBeCloseTo(800);
    expect(wrapper.findComponent(PieceBox).props("scale")).toBeCloseTo(1);
    wrapper.unmount();
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
