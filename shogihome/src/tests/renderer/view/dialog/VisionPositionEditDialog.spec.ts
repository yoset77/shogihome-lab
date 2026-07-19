import { shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VisionPositionEditDialog from "@/renderer/view/dialog/VisionPositionEditDialog.vue";
import PositionEditorCore from "@/renderer/view/dialog/PositionEditorCore.vue";
import type { VisionEditSession } from "@/renderer/vision/types";
import { InitialPositionSFEN, Position } from "tsshogi";

const destroyModalDialog = vi.hoisted(() => vi.fn());
const importVisionSFEN = vi.hoisted(() => vi.fn());
const isMobileWebApp = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/renderer/store", () => ({
  useStore: () => ({ destroyModalDialog, importVisionSFEN }),
}));

vi.mock("@/renderer/ipc/api", () => ({ isMobileWebApp }));

const createSession = (): VisionEditSession => ({
  sourceImage: new Blob(["image"], { type: "image/jpeg" }),
  response: {
    ok: true,
    sfen: "9/9/9/9/9/9/9/9/9 b - 1",
    confidence: 0.123456,
    candidates: [
      {
        sfen: "9/9/9/9/9/9/9/9/9 b - 1",
        score: 0.234567,
        violations: [{ code: "IMMOBILE_PIECE", message: "SECRET_CANDIDATE_WARNING" }],
      },
    ],
    warnings: [{ code: "BOARD_NOT_FOUND", message: "SECRET_SCAN_WARNING" }],
  },
  viewpoint: "black",
  positionType: "game",
});

describe("VisionPositionEditDialog", () => {
  beforeEach(() => {
    destroyModalDialog.mockReset();
    importVisionSFEN.mockReset();
    isMobileWebApp.mockReturnValue(false);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:source-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the source image on its tab and releases the object URL", async () => {
    const session = createSession();
    const wrapper = shallowMount(VisionPositionEditDialog, {
      props: { session },
      global: {
        stubs: {
          DialogFrame: { template: "<div><slot /></div>" },
          BoardView: true,
          PieceBox: true,
        },
      },
    });

    expect(wrapper.find(".position-tab").exists()).toBe(true);
    expect(wrapper.find(".source-image").exists()).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain("0.123456");
    expect(wrapper.text()).not.toContain("0.234567");
    expect(wrapper.text()).not.toContain("SECRET_CANDIDATE_WARNING");
    expect(wrapper.text()).not.toContain("SECRET_SCAN_WARNING");

    await wrapper.find('[data-tab="source"]').trigger("click");

    expect(URL.createObjectURL).toHaveBeenCalledWith(session.sourceImage);
    expect(wrapper.find(".source-image").attributes("src")).toBe("blob:source-image");

    await wrapper.find('[data-tab="position"]').trigger("click");
    await wrapper.find('[data-tab="source"]').trigger("click");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:source-image");
  });

  it("removes the redundant title on mobile", () => {
    isMobileWebApp.mockReturnValue(true);

    const wrapper = shallowMount(VisionPositionEditDialog, {
      props: { session: createSession() },
      global: {
        stubs: {
          DialogFrame: { template: "<div><slot /></div>" },
          BoardView: true,
          PieceBox: true,
        },
      },
    });

    expect(wrapper.find(".vision-position-edit-dialog").classes()).toContain("mobile");
    expect(wrapper.find(".dialog-header").exists()).toBe(false);
  });

  it("imports the position emitted by the shared editor core", async () => {
    const wrapper = shallowMount(VisionPositionEditDialog, {
      props: { session: createSession() },
      global: {
        stubs: {
          DialogFrame: { template: "<div><slot /></div>" },
        },
      },
    });
    const position = Position.newBySFEN(InitialPositionSFEN.HANDICAP_ROOK) as Position;

    wrapper.findComponent(PositionEditorCore).vm.$emit("change", position);
    await wrapper.vm.$nextTick();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "OK")
      ?.trigger("click");

    expect(importVisionSFEN).toHaveBeenCalledWith(InitialPositionSFEN.HANDICAP_ROOK);
    expect(destroyModalDialog).toHaveBeenCalled();
  });
});
