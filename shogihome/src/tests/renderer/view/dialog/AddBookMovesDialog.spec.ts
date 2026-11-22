import { flushPromises, shallowMount } from "@vue/test-utils";
import { Record } from "tsshogi";
import { defaultBookImportSettings } from "@/common/settings/book";
import { t } from "@/common/i18n";
import { useConfirmationStore } from "@/renderer/store/confirm";
import AddBookMovesDialog from "@/renderer/view/dialog/AddBookMovesDialog.vue";

const mocks = vi.hoisted(() => ({
  record: {} as { record: Record },
  searchMovesBatch: vi.fn(),
  updateMove: vi.fn(),
  updateMoves: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/renderer/store", () => ({ useStore: () => mocks.record }));
vi.mock("@/renderer/store/book", () => ({
  useBookStore: () => ({
    activeBookId: "test-session",
    searchMovesBatch: mocks.searchMovesBatch,
    updateMove: mocks.updateMove,
    updateMoves: mocks.updateMoves,
  }),
}));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.error }) }));
vi.mock("@/renderer/store/toast", () => ({ useToastStore: () => ({ success: mocks.success }) }));
vi.mock("@/renderer/ipc/api", () => ({
  default: { loadBookImportSettings: async () => defaultBookImportSettings() },
}));

describe("AddBookMovesDialog", () => {
  const mountDialog = () =>
    shallowMount(AddBookMovesDialog, {
      global: { stubs: { DialogFrame: { template: "<div><slot /></div>" } } },
    });

  let positions: string[];
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    const record = new Record();
    positions = [];
    for (const usi of ["7g7f", "3c3d", "2g2f"]) {
      positions.push(record.position.sfen);
      record.append(record.position.createMoveByUSI(usi)!);
    }
    record.current.customData = { researchInfo: { score: 200, depth: 22 } };
    record.goto(0);
    mocks.record.record = record;
    mocks.searchMovesBatch.mockResolvedValue(
      new Map([
        [positions[0], [{ usi: "7g7f", comment: "already registered" }]],
        [positions[2], [{ usi: "2g2f", comment: "keep", score: 50 }]],
      ]),
    );
  });

  afterEach(() => useConfirmationStore().cancel());

  it("sends only eligible moves in one batch after confirmation", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.findAll(".move-list button")).toHaveLength(2);
    await wrapper.get(".register-all").trigger("click");
    expect(mocks.updateMoves).not.toHaveBeenCalled();
    useConfirmationStore().ok();
    await flushPromises();
    expect(mocks.updateMoves).toHaveBeenCalledExactlyOnceWith(
      [
        { sfen: positions[1], move: { usi: "3c3d", comment: "" } },
        { sfen: positions[2], move: { usi: "2g2f", comment: "keep", score: 200, depth: 22 } },
      ],
      "test-session",
    );
    expect(mocks.updateMove).not.toHaveBeenCalled();
    expect(wrapper.findAll(".move-list button")).toHaveLength(0);
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith(t.importedMoves(2));
    wrapper.unmount();
  });

  it("leaves every move eligible and does not show success if the batch fails", async () => {
    const failure = new Error("batch failed");
    mocks.updateMoves.mockRejectedValueOnce(failure);
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.get(".register-all").trigger("click");
    useConfirmationStore().ok();
    await flushPromises();
    expect(wrapper.findAll(".move-list button")).toHaveLength(2);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(mocks.success).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
