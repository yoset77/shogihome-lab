import { shallowMount } from "@vue/test-utils";
import { reactive, nextTick } from "vue";
import { Record, type Move, type ImmutablePosition } from "tsshogi";
import { AppState } from "@/common/control/state";
import { RectSize } from "@/common/assets/geometry";
import { defaultAppSettings } from "@/common/settings/app";
import BoardPane from "@/renderer/view/main/BoardPane.vue";
import BoardView from "@/renderer/view/primitive/BoardView.vue";

const storeMock = vi.hoisted(() => ({
  appState: "game",
  record: undefined as unknown as Record,
  boardPosition: undefined as unknown as ImmutablePosition,
  boardLastMove: undefined as Move | undefined,
  candidates: [] as Move[],
  isMovableByUser: true,
  blackTime: 60,
  blackByoyomi: 10,
  whiteTime: 60,
  whiteByoyomi: 10,
  doGameMove: vi.fn(),
  doMove: vi.fn(),
}));
const store = reactive(storeMock);

vi.mock("@/renderer/store", () => ({ useStore: () => store }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => defaultAppSettings() }));
vi.mock("@/renderer/ipc/api", () => ({ isMobileWebApp: () => false }));
vi.mock("@/renderer/view/main/ControlPane.vue", () => ({
  default: { template: "<div />" },
  ControlGroup: { Group1: "group1", Group2: "group2" },
}));

describe("BoardPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.appState = AppState.GAME;
    store.record = new Record();
    store.boardPosition = store.record.position;
    store.boardLastMove = undefined;
    store.isMovableByUser = true;
  });

  it("renders the display-only move and returns to the confirmed board on rejection", async () => {
    const wrapper = shallowMount(BoardPane, { props: { maxSize: new RectSize(600, 600) } });
    const board = wrapper.getComponent(BoardView);
    const preview = store.record.position.clone();
    const move = preview.createMoveByUSI("7g7f")!;
    board.vm.$emit("move", move);
    expect(store.doGameMove).toHaveBeenCalledWith(move);
    expect(store.doMove).not.toHaveBeenCalled();

    preview.doMove(move);
    store.boardPosition = preview;
    store.boardLastMove = move;
    store.isMovableByUser = false;
    await nextTick();
    expect(board.props("position").sfen).toBe(preview.sfen);
    expect(board.props("lastMove")?.usi).toBe("7g7f");
    expect(board.props("allowMove")).toBe(false);
    expect(board.props("blackPlayerTime")).toBe(60);
    expect(board.props("whitePlayerTime")).toBe(60);
    expect(store.record.current.ply).toBe(0);

    store.boardPosition = store.record.position;
    store.boardLastMove = undefined;
    store.isMovableByUser = true;
    await nextTick();
    expect(board.props("position").sfen).toBe(store.record.position.sfen);
    expect(board.props("lastMove")).toBeNull();
    expect(board.props("allowMove")).toBe(true);
    wrapper.unmount();
  });

  it("keeps ordinary record editing on the existing move path", () => {
    store.appState = AppState.NORMAL;
    const wrapper = shallowMount(BoardPane, { props: { maxSize: new RectSize(600, 600) } });
    const board = wrapper.getComponent(BoardView);
    const move = store.record.position.createMoveByUSI("7g7f")!;
    board.vm.$emit("move", move);
    expect(store.doMove).toHaveBeenCalledWith(move);
    expect(store.doGameMove).not.toHaveBeenCalled();
    expect(board.props("hideClock")).toBe(true);
    expect(board.props("position").sfen).toBe(store.record.position.sfen);
    wrapper.unmount();
  });
});
