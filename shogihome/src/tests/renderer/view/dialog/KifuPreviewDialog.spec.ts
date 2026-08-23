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

function createDeferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
}

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

const mountDialog = (props?: {
  matchedPly?: number;
  matchedSfen?: string;
  targets?: { path: string; matchedPly?: number; matchedSfen?: string }[];
  targetIndex?: number;
}) =>
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
            '<div class="board-view-stub"><span class="black-hand-count">{{ blackHandCount }}</span><slot name="left-control" /><slot name="right-control" /></div>',
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

  it("reloads the preview when the selected target changes", async () => {
    const secondRecord = new Record();
    const move = secondRecord.position.createMoveByUSI("2g2f");
    if (!move) throw new Error("Failed to create test move");
    secondRecord.append(move);

    loadServerKifu.mockImplementation(async (path: string) => `server://${path}`);
    importRecordFromBuffer.mockReturnValueOnce(parsedRecord).mockReturnValueOnce(secondRecord);
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.setProps({ path: "games/second.kif" });
    await flushPromises();

    expect(loadServerKifu).toHaveBeenLastCalledWith("games/second.kif");
    expect(openRecord).toHaveBeenLastCalledWith("server://games/second.kif");
    expect(wrapper.find(".file-path").text()).toBe("second.kif");
    expect(wrapper.findComponent({ name: "BoardView" }).props("position").sfen).toBe(
      secondRecord.position.sfen,
    );
  });

  it("keeps the latest preview when an earlier load completes late", async () => {
    const firstLoad = createDeferred<Uint8Array>();
    const secondLoad = createDeferred<Uint8Array>();
    const firstRecord = new Record();
    const firstMove = firstRecord.position.createMoveByUSI("7g7f");
    if (!firstMove) throw new Error("Failed to create test move");
    firstRecord.append(firstMove);
    const secondRecord = new Record();
    const secondMove = secondRecord.position.createMoveByUSI("2g2f");
    if (!secondMove) throw new Error("Failed to create test move");
    secondRecord.append(secondMove);

    loadServerKifu.mockImplementation(async (path: string) => `server://${path}`);
    openRecord.mockImplementation((uri: string) =>
      uri.endsWith("example.kif") ? firstLoad.promise : secondLoad.promise,
    );
    importRecordFromBuffer.mockImplementation((data: Uint8Array) =>
      data[0] === 1 ? firstRecord : secondRecord,
    );

    const wrapper = mountDialog();
    await vi.waitFor(() => expect(openRecord).toHaveBeenCalledWith("server://games/example.kif"));

    await wrapper.setProps({ path: "games/second.kif" });
    await vi.waitFor(() => expect(openRecord).toHaveBeenCalledWith("server://games/second.kif"));

    secondLoad.resolve(new Uint8Array([2]));
    await flushPromises();
    firstLoad.resolve(new Uint8Array([1]));
    await flushPromises();

    expect(wrapper.findComponent({ name: "BoardView" }).props("position").sfen).toBe(
      secondRecord.position.sfen,
    );
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

  it("provides desktop actions for opening and navigating preview targets", async () => {
    const wrapper = mountDialog({
      targets: [
        { path: "games/first.kif" },
        { path: "games/example.kif", matchedPly: 1 },
        { path: "games/last.kif" },
      ],
      targetIndex: 1,
    });
    await flushPromises();

    const buttons = wrapper.findAll(".desktop-preview-actions button");
    expect(buttons).toHaveLength(3);
    expect(buttons[1].attributes("disabled")).toBeUndefined();
    expect(buttons[2].attributes("disabled")).toBeUndefined();

    await buttons[0].trigger("click");
    await buttons[1].trigger("click");
    await buttons[2].trigger("click");

    expect(wrapper.emitted("open")).toHaveLength(1);
    expect(wrapper.emitted("previous")).toHaveLength(1);
    expect(wrapper.emitted("next")).toHaveLength(1);
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
    expect(wrapper.find(".desktop-preview-actions").exists()).toBe(false);
  });
});
