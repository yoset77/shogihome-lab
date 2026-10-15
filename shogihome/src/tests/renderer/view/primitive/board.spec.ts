import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import { Color, Piece, PieceType, Position, Square } from "tsshogi";
import { RectSize } from "@/common/assets/geometry";
import {
  BoardImageType,
  BoardLabelType,
  KingPieceType,
  PieceStandImageType,
} from "@/common/settings/app";

enableAutoUnmount(afterEach);

const mountEditable = (position = new Position(), mobile = false) =>
  shallowMount(BoardView, {
    props: {
      boardImageType: BoardImageType.LIGHT,
      pieceStandImageType: PieceStandImageType.STANDARD,
      pieceImageUrlTemplate: "./piece/hitomoji/${piece}.png",
      kingPieceType: KingPieceType.GYOKU_AND_OSHO,
      boardLabelType: BoardLabelType.STANDARD,
      maxSize: new RectSize(800, 600),
      position,
      allowEdit: true,
      mobile,
    },
  });

const pointerEvent = (type: string, clientX: number, clientY: number) => {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
};

describe("BoardView", () => {
  it("hitomoji", () => {
    const position = new Position();
    const wrapper = shallowMount(BoardView, {
      props: {
        boardImageType: BoardImageType.LIGHT,
        pieceStandImageType: PieceStandImageType.STANDARD,
        pieceImageUrlTemplate: "./piece/hitomoji/${piece}.png",
        kingPieceType: KingPieceType.GYOKU_AND_OSHO,
        boardLabelType: BoardLabelType.STANDARD,
        maxSize: new RectSize(800, 600),
        position,
      },
    });
    const imgs = wrapper.findAll("img");
    expect(imgs.filter((img) => img.attributes()["src"] === "./board/wood_light.png")).toHaveLength(
      1,
    );
    expect(
      imgs.filter((img) => img.attributes()["src"] === "./piece/hitomoji/white_bishop.png"),
    ).toHaveLength(1);
    expect(
      imgs.filter((img) => img.attributes()["src"] === "./piece/hitomoji/black_rook.png"),
    ).toHaveLength(1);
    expect(
      imgs.filter((img) => img.attributes()["src"] === "./piece/hitomoji/black_gold.png"),
    ).toHaveLength(2);
    expect(
      imgs.filter((img) => img.attributes()["src"] === "./piece/hitomoji_gothic/black_gold.png"),
    ).toHaveLength(0);
  });

  describe("piece rotation", () => {
    it.each([false, true])("rotates on a same-square double-click (mobile=%s)", async (mobile) => {
      const wrapper = mountEditable(new Position(), mobile);
      const square = new Square(8, 8);
      const target = wrapper.findAll(".board.operation > div")[square.index];

      await target.trigger("click");
      await target.trigger("click");
      await target.trigger("dblclick");

      expect(wrapper.emitted("edit")).toEqual([[{ rotate: square }]]);
    });

    it.each([false, true])(
      "ignores a different-square double-click (mobile=%s)",
      async (mobile) => {
        const wrapper = mountEditable(new Position(), mobile);
        const squares = wrapper.findAll(".board.operation > div");
        const from = new Square(8, 8);
        // Keep the destination occupied even before the parent applies the edit.
        const to = new Square(5, 1);

        await squares[from.index].trigger("click");
        await squares[to.index].trigger("click");
        await squares[to.index].trigger("dblclick");

        expect(wrapper.emitted("edit")).toEqual([[{ move: { from, to } }]]);
      },
    );

    it("ignores an unintended double-click after the parent applies a move", async () => {
      const position = new Position();
      const wrapper = mountEditable(position, true);
      const squares = wrapper.findAll(".board.operation > div");
      const from = new Square(8, 8);
      const to = new Square(5, 5);

      await squares[from.index].trigger("click");
      await squares[to.index].trigger("click");
      const updated = position.clone();
      updated.edit({ move: { from, to } });
      await wrapper.setProps({ position: updated });
      await squares[to.index].trigger("dblclick");

      expect(wrapper.emitted("edit")).toEqual([[{ move: { from, to } }]]);
    });

    it("rotates on right-click without preceding clicks", async () => {
      const wrapper = mountEditable();
      const square = new Square(8, 8);

      await wrapper.findAll(".board.operation > div")[square.index].trigger("contextmenu");

      expect(wrapper.emitted("edit")).toEqual([[{ rotate: square }]]);
    });

    it.each([".frame", ".hand.operation > div:first-child", ".hand.operation > div:nth-child(2)"])(
      "breaks the double-click sequence on %s",
      async (selector) => {
        const wrapper = mountEditable();
        const square = new Square(8, 8);
        const target = wrapper.findAll(".board.operation > div")[square.index];

        await target.trigger("click");
        await wrapper.find(selector).trigger("click");
        await target.trigger("click");
        await target.trigger("dblclick");

        expect(wrapper.emitted("edit") ?? []).not.toContainEqual([{ rotate: square }]);
      },
    );

    it("ignores a different-square double-click after dragging a piece", async () => {
      const position = new Position();
      const wrapper = mountEditable(position, true);
      const squares = wrapper.findAll(".board.operation > div");
      const from = new Square(8, 8);
      const to = new Square(5, 5);
      const next = new Square(5, 1);
      const center = (square: Square) => {
        const style = (squares[square.index].element as HTMLElement).style;
        return {
          x: parseFloat(style.left) + parseFloat(style.width) / 2,
          y: parseFloat(style.top) + parseFloat(style.height) / 2,
        };
      };
      const start = center(from);
      const end = center(to);

      squares[from.index].element.dispatchEvent(pointerEvent("pointerdown", start.x, start.y));
      document.dispatchEvent(pointerEvent("pointermove", end.x, end.y));
      document.dispatchEvent(pointerEvent("pointerup", end.x, end.y));
      await squares[to.index].trigger("click");
      const updated = position.clone();
      updated.edit({ move: { from, to } });
      await wrapper.setProps({ position: updated });
      await squares[next.index].trigger("click");
      await squares[next.index].trigger("dblclick");

      expect(wrapper.emitted("edit")).toEqual([[{ move: { from, to } }]]);
    });

    it("does not rotate on an unintended double-click when placing from the piece box", async () => {
      const wrapper = mountEditable(new Position(), true);
      const square = new Square(5, 1);
      const target = wrapper.findAll(".board.operation > div")[square.index];

      await wrapper.setProps({ pieceBoxSelection: PieceType.PAWN });
      await target.trigger("click");
      await target.trigger("dblclick");

      expect(wrapper.emitted("pieceBoxDrop")).toEqual([[PieceType.PAWN, square]]);
      expect(wrapper.emitted("edit")).toBeUndefined();
    });

    it("preserves mobile promotion selection on an unintended double-click", async () => {
      const position = Position.newBySFEN("4k4/9/9/4P4/9/9/9/9/4K4 b - 1") as Position;
      const wrapper = mountEditable(position, true);
      await wrapper.setProps({ allowEdit: false, allowMove: true });
      const squares = wrapper.findAll(".board.operation > div");

      await squares[new Square(5, 4).index].trigger("click");
      await squares[new Square(5, 3).index].trigger("click");
      expect(wrapper.find(".promote").exists()).toBe(true);
      await squares[new Square(5, 3).index].trigger("dblclick");
      await wrapper.get(".promote").trigger("click");

      expect(wrapper.emitted("move")).toEqual([[position.createMoveByUSI("5d5c+")]]);
    });
  });

  it("teleports an external drag ghost into the active dialog", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const position = new Position();
    const wrapper = shallowMount(BoardView, {
      attachTo: document.body,
      props: {
        boardImageType: BoardImageType.LIGHT,
        pieceStandImageType: PieceStandImageType.STANDARD,
        pieceImageUrlTemplate: "./piece/hitomoji/${piece}.png",
        kingPieceType: KingPieceType.GYOKU_AND_OSHO,
        boardLabelType: BoardLabelType.STANDARD,
        maxSize: new RectSize(800, 600),
        position,
        allowEdit: true,
        ghostTeleportTarget: target,
      },
      global: { stubs: { teleport: false } },
    });

    await wrapper.setProps({
      externalDrag: {
        piece: new Piece(Color.BLACK, PieceType.PAWN),
        pieceImagePath: "/piece/ghost.png",
        pointerId: 7,
        clientX: 0,
        clientY: 0,
        source: "pieceBox",
      },
    });
    const pointerMove = new Event("pointermove") as PointerEvent;
    Object.defineProperties(pointerMove, {
      pointerId: { value: 7 },
      clientX: { value: 10 },
      clientY: { value: 10 },
    });
    document.dispatchEvent(pointerMove);
    await wrapper.vm.$nextTick();

    expect(target.querySelector('img[src="/piece/ghost.png"]')).not.toBeNull();
    wrapper.unmount();
    target.remove();
  });
});
