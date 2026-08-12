import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Color, ImmutablePosition, PieceType, Record } from "tsshogi";
import { computed, PropType } from "vue";
import KifuPreviewDialog from "@/renderer/view/dialog/KifuPreviewDialog.vue";

const loadServerKifu = vi.hoisted(() => vi.fn());
const openRecord = vi.hoisted(() => vi.fn());
const isMobileWebApp = vi.hoisted(() => vi.fn(() => false));
const importRecordFromBuffer = vi.hoisted(() => vi.fn());
const detectRecordFileFormatByPath = vi.hoisted(() => vi.fn(() => ".kif"));
const installHotKey = vi.hoisted(() => vi.fn());
const uninstallHotKey = vi.hoisted(() => vi.fn());
let parsedRecord: Record;

vi.mock("@/renderer/ipc/api", () => ({
  default: { loadServerKifu, openRecord },
  isMobileWebApp,
}));
vi.mock("@/common/file/record", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/common/file/record")>();
  return {
    ...actual,
    detectRecordFileFormatByPath,
    importRecordFromBuffer,
  };
});
vi.mock("@/renderer/store/busy", () => ({
  useBusyState: () => ({ retain: vi.fn(), release: vi.fn() }),
}));
vi.mock("@github/hotkey", () => ({ install: installHotKey, uninstall: uninstallHotKey }));

const mountDialog = (props?: { matchedPly?: number; matchedSfen?: string }) =>
  shallowMount(KifuPreviewDialog, {
    props: {
      path: "games/example.kif",
      ...props,
    },
    global: {
      stubs: {
        DialogFrame: { template: "<div><slot /></div>" },
        BoardView: {
          name: "BoardView",
          props: {
            position: { type: Object as PropType<ImmutablePosition>, required: true },
            mobile: { type: Boolean, required: false },
            layoutType: { type: String, required: false },
            maxSize: { type: Object, required: false },
          },
          setup(props) {
            const blackHandCount = computed(() =>
              props.position.hand(Color.BLACK).count(PieceType.PAWN),
            );
            return { blackHandCount };
          },
          template:
            '<div class="board-view-stub"><span class="black-hand-count">{{ blackHandCount }}</span><slot name="right-control" /></div>',
        },
        RecordView: {
          name: "RecordView",
          props: ["record", "showBranches", "showElapsedTime", "branchListMode"],
          template: '<div class="record-view-stub" />',
        },
        Icon: true,
      },
    },
  });

describe("KifuPreviewDialog", () => {
  beforeEach(() => {
    loadServerKifu.mockReset();
    openRecord.mockReset();
    importRecordFromBuffer.mockReset();
    installHotKey.mockReset();
    uninstallHotKey.mockReset();
    detectRecordFileFormatByPath.mockClear();
    isMobileWebApp.mockReturnValue(false);

    parsedRecord = new Record();
    const firstMove = parsedRecord.position.createMoveByUSI("7g7f");
    const secondMove = parsedRecord.position.createMoveByUSI("3c3d");
    if (!firstMove || !secondMove) throw new Error("Failed to create test moves");
    parsedRecord.append(firstMove);
    parsedRecord.append(secondMove);

    loadServerKifu.mockResolvedValue("server://games/example.kif");
    openRecord.mockResolvedValue(new Uint8Array([1, 2, 3]));
    importRecordFromBuffer.mockImplementation(() => parsedRecord);
  });

  it("loads at the matched ply without changing the source file", async () => {
    const wrapper = mountDialog({ matchedPly: 1 });
    await flushPromises();

    expect(loadServerKifu).toHaveBeenCalledWith("games/example.kif");
    expect(openRecord).toHaveBeenCalledWith("server://games/example.kif");
    expect(parsedRecord.current.ply).toBe(1);
    expect(wrapper.find(".board-view-stub").exists()).toBe(true);
  });

  it("provides PV preview controls on desktop", async () => {
    const wrapper = mountDialog({ matchedPly: 1 });
    await flushPromises();

    const boardSize = wrapper.findComponent({ name: "BoardView" }).props("maxSize") as {
      width: number;
      height: number;
    };
    expect(boardSize.width + 300 + 15).toBeLessThanOrEqual(window.innerWidth * 0.95 - 30 + 0.001);

    const buttons = wrapper.findAll(".desktop-controls button");
    expect(buttons).toHaveLength(6);

    await buttons[4].trigger("click");
    expect(parsedRecord.current.ply).toBe(0);

    await buttons[5].trigger("click");
    expect(parsedRecord.current.ply).toBe(1);

    await buttons[3].trigger("click");
    expect(parsedRecord.current.ply).toBe(2);

    await buttons[2].trigger("click");
    expect(parsedRecord.current.ply).toBe(0);
  });

  it("installs hotkeys for controls rendered after loading", async () => {
    const wrapper = mountDialog({ matchedPly: 1 });

    expect(installHotKey).not.toHaveBeenCalled();
    await flushPromises();

    const buttons = wrapper.findAll(".desktop-controls button");
    await vi.waitFor(() => expect(installHotKey).toHaveBeenCalledTimes(buttons.length));
    expect(installHotKey.mock.calls.map(([element]) => element)).toEqual(
      buttons.map((button) => button.element),
    );

    wrapper.unmount();
    expect(uninstallHotKey).toHaveBeenCalledTimes(buttons.length);
  });

  it("updates hand pieces after a capture and a drop", async () => {
    const recordOrError = Record.newByUSI(
      "position startpos moves 7g7f 3c3d 2g2f 8c8d 2f2e 8d8e 2e2d 8e8f 2d2c 8f8g P*4c",
    );
    if (recordOrError instanceof Error) throw recordOrError;
    recordOrError.goto(0);
    parsedRecord = recordOrError;

    const wrapper = mountDialog();
    await flushPromises();

    const forwardButton = wrapper.findAll(".desktop-controls button")[5];
    const blackHandCount = () => wrapper.find(".black-hand-count").text();

    expect(blackHandCount()).toBe("0");

    for (let i = 0; i < 9; i++) {
      await forwardButton.trigger("click");
    }
    expect(parsedRecord.current.ply).toBe(9);
    expect(blackHandCount()).toBe("1");

    await forwardButton.trigger("click");
    await forwardButton.trigger("click");
    expect(blackHandCount()).toBe("0");
  });

  it("omits the dialog title and back-to-main-branch control", async () => {
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.find(".title").exists()).toBe(false);
    expect(
      wrapper.findComponent({ name: "RecordView" }).props("backToMainBranchLabel"),
    ).toBeUndefined();
  });

  it("follows the elapsed time display setting", async () => {
    const wrapper = mountDialog();
    await flushPromises();

    const recordView = wrapper.findComponent({ name: "RecordView" });
    expect(recordView.props("showElapsedTime")).toBe(true);
  });

  it("displays only the file name", async () => {
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.find(".file-path").text()).toBe("example.kif");
    expect(wrapper.find(".file-path").attributes("title")).toBe("games/example.kif");
  });

  it("shows branch choices and switches the local record branch", async () => {
    parsedRecord.goBack();
    const alternateMove = parsedRecord.position.createMoveByUSI("8c8d");
    if (!alternateMove) throw new Error("Failed to create alternate test move");
    parsedRecord.append(alternateMove);
    const mainBranchNode = parsedRecord.branchBegin;
    if (!mainBranchNode.branch) throw new Error("Failed to create a branch");

    const wrapper = mountDialog();
    await flushPromises();

    const recordView = wrapper.findComponent({ name: "RecordView" });
    expect(recordView.props("showBranches")).toBe(true);

    await recordView.vm.$emit("select-branch", 0);

    expect(parsedRecord.current.sfen).toBe(mainBranchNode.sfen);
  });

  it("uses a mobile shell and portrait board layout", async () => {
    isMobileWebApp.mockReturnValue(true);
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.find(".preview-dialog").exists()).toBe(true);
    const boardView = wrapper.findComponent({ name: "BoardView" });
    expect(boardView.props("mobile")).toBe(true);
    expect((boardView.props("maxSize") as { height: number }).height).toBeGreaterThan(
      window.innerHeight * 0.42,
    );
    expect(wrapper.find(".preview-dialog").classes()).toContain("preview-dialog-constrained");
    expect(wrapper.findAll(".mobile-controls button")).toHaveLength(6);
  });
});
