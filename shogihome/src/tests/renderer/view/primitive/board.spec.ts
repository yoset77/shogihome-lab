import { shallowMount } from "@vue/test-utils";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import { Color, Piece, PieceType, Position } from "tsshogi";
import { RectSize } from "@/common/assets/geometry";
import {
  BoardImageType,
  BoardLabelType,
  KingPieceType,
  PieceStandImageType,
} from "@/common/settings/app";

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
