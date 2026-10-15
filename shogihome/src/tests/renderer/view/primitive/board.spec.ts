import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import { Color, handPieceTypes, Move, Piece, PieceType, Position, Square } from "tsshogi";
import { RectSize } from "@/common/assets/geometry";
import { BoardLayoutType } from "@/common/settings/layout";
import { boardParams } from "@/renderer/view/primitive/board/params";
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

  describe("candidate arrows", () => {
    const centerInFrame = (parent: Element, child: Element) => {
      const parentStyle = (parent as HTMLElement).style;
      const childStyle = (child as HTMLElement).style;
      return {
        x:
          parseFloat(parentStyle.left) +
          parseFloat(childStyle.left) +
          parseFloat(childStyle.width) / 2,
        y:
          parseFloat(parentStyle.top) +
          parseFloat(childStyle.top) +
          parseFloat(childStyle.height) / 2,
      };
    };

    const expectArrow = (wrapper: ReturnType<typeof mountEditable>, candidate: Move) => {
      const arrows = wrapper.findAll("svg.arrows");
      expect(arrows).toHaveLength(1);
      expect(wrapper.find("img.arrows").exists()).toBe(false);
      const arrow = arrows[0];
      const style = (arrow.element as SVGElement).style;
      const width = parseFloat(style.width);
      const height = parseFloat(style.height);
      expect(arrow.element.namespaceURI).toBe("http://www.w3.org/2000/svg");
      expect(arrow.attributes("viewBox")?.split(" ").map(Number)).toEqual([0, 0, width, height]);
      expect(style.objectFit).toBe("");
      expect(style.objectPosition).toBe("");

      const polygon = arrow.get("polygon");
      expect(polygon.attributes("fill")).toBe("#fe0000");
      const points = polygon
        .attributes("points")
        ?.split(" ")
        .map((point) => point.split(",").map(Number));
      const headLength = Math.min(height * 0.79, width);
      expect(points).toEqual([
        [0, height / 2],
        [headLength, 0],
        [headLength, height * 0.31],
        [width, height * 0.31],
        [width, height * 0.665],
        [headLength, height * 0.665],
        [headLength, height],
      ]);

      const board = wrapper.get(".board.operation");
      const squares = board.findAll("div");
      const squareCenter = (square: Square) =>
        centerInFrame(board.element, squares[square.index].element);
      const end = squareCenter(candidate.to);
      let start;
      if (candidate.from instanceof Square) {
        start = squareCenter(candidate.from);
      } else {
        const hand = wrapper.findAll(".hand.operation")[candidate.color === Color.BLACK ? 0 : 1];
        const index =
          wrapper.props("layoutType") === BoardLayoutType.STANDARD
            ? handPieceTypes.indexOf(candidate.from)
            : 0;
        start = centerInFrame(hand.element, hand.findAll("div")[index + 1].element);
      }
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      expect(width).toBeCloseTo(distance, 6);
      const squareWidth = parseFloat((squares[0].element as HTMLElement).style.width);
      expect(height).toBeCloseTo((30 * squareWidth) / boardParams.squareWidth, 6);

      // CSS rotates around the SVG center; its left tip must land on the destination.
      const angle = Number(style.transform.match(/^rotate\((.*)rad\)$/)?.[1]);
      const centerX = parseFloat(style.left) + width / 2;
      const centerY = parseFloat(style.top) + height / 2;
      expect(centerX - (width / 2) * Math.cos(angle)).toBeCloseTo(end.x, 6);
      expect(centerY - (width / 2) * Math.sin(angle)).toBeCloseTo(end.y, 6);
      expect(centerX + (width / 2) * Math.cos(angle)).toBeCloseTo(start.x, 6);
      expect(centerY + (width / 2) * Math.sin(angle)).toBeCloseTo(start.y, 6);
    };

    describe.each(Object.values(BoardLayoutType))("%s layout", (layoutType) => {
      const cases = [
        { usi: "6g6f", color: Color.BLACK },
        { usi: "2h6h", color: Color.BLACK },
        { usi: "8h3c+", color: Color.BLACK },
        { usi: "2i1g", color: Color.BLACK },
        { usi: "P*5f", color: Color.BLACK },
        { usi: "P*5d", color: Color.WHITE },
      ].flatMap((candidate) => [false, true].map((flip) => ({ ...candidate, flip })));

      it.each(cases)(
        "renders $usi and follows resizing (flip=$flip)",
        async ({ usi, color, flip }) => {
          const position = Position.newBySFEN("4k4/9/6p2/9/9/9/3P5/1B5R1/4K2N1 b Pp 1") as Position;
          position.setColor(color);
          const candidate = position.createMoveByUSI(usi) as Move;
          expect(position.isValidMove(candidate)).toBe(true);
          const wrapper = mountEditable(position);
          await wrapper.setProps({ layoutType, flip, candidates: [candidate] });

          expectArrow(wrapper, candidate);
          await wrapper.setProps({ maxSize: new RectSize(320, 480) });
          expectArrow(wrapper, candidate);
        },
      );
    });

    it("removes arrows when candidates are cleared", async () => {
      const position = new Position();
      const wrapper = mountEditable(position);
      expect(wrapper.find(".arrows").exists()).toBe(false);

      await wrapper.setProps({ candidates: [position.createMoveByUSI("7g7f") as Move] });
      expect(wrapper.findAll("svg.arrows")).toHaveLength(1);
      await wrapper.setProps({ candidates: [] });
      expect(wrapper.find(".arrows").exists()).toBe(false);
    });
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
