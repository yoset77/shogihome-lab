import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { Color, InitialPositionSFEN, Piece, PieceType, Position } from "tsshogi";
import PieceBox from "@/renderer/view/primitive/PieceBox.vue";

vi.mock("@/renderer/store/settings", () => ({
  useAppSettings: () => ({ pieceImage: "hitomoji" }),
}));

const createPosition = () => Position.newBySFEN(InitialPositionSFEN.EMPTY) as Position;

describe("PieceBox", () => {
  it("does not enable mobile styling by default", () => {
    const wrapper = mount(PieceBox, { props: { position: createPosition() } });

    expect(wrapper.classes()).not.toContain("mobile");
    expect(wrapper.findAll(".piece-box-item")).toHaveLength(8);
  });

  it("toggles mobile styling without hiding any piece types", async () => {
    const wrapper = mount(PieceBox, {
      props: { position: createPosition(), mobile: true },
    });

    expect(wrapper.classes()).toContain("mobile");
    expect(wrapper.findAll(".piece-box-item")).toHaveLength(8);

    await wrapper.setProps({ mobile: false });
    expect(wrapper.classes()).not.toContain("mobile");
  });

  it("selects mobile pieces using the entire cell", () => {
    const wrapper = mount(PieceBox, {
      props: { position: createPosition(), mobile: true },
    });

    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.assign(event, {
      button: 0,
      pointerId: 7,
      clientX: 20,
      clientY: 30,
    });
    wrapper.find(".piece-box-item").element.dispatchEvent(event);

    const drag = wrapper.emitted("dragstart")?.[0];
    expect(drag?.[0]).toEqual(new Piece(Color.BLACK, PieceType.ROOK));
    expect(drag?.slice(2)).toEqual([7, 20, 30]);
    expect(wrapper.emitted("tapDrop")).toBeUndefined();
  });

  it("accepts returning a selected piece by tapping a depleted mobile cell", () => {
    const wrapper = mount(PieceBox, {
      props: {
        position: Position.newBySFEN(InitialPositionSFEN.STANDARD) as Position,
        mobile: true,
        acceptTapDrop: true,
      },
    });

    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    wrapper.find(".piece-box-item.empty").element.dispatchEvent(event);

    expect(wrapper.emitted("tapDrop")).toHaveLength(1);
    expect(wrapper.emitted("dragstart")).toBeUndefined();
  });
});
