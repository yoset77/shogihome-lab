import { shallowMount } from "@vue/test-utils";
import { Record } from "tsshogi";
import { beforeEach, vi } from "vitest";
import { nextTick } from "vue";
import BookPanel from "@/renderer/view/main/BookPanel.vue";
import BookComparisonColumn from "@/renderer/view/main/BookComparisonColumn.vue";
import BookMoveDialog from "@/renderer/view/dialog/BookMoveDialog.vue";

const { newBook, storeMock, confirmationShowMock, bookStoreMock } = vi.hoisted(() => {
  const existingBook = {
    sessionId: "existing",
    path: "server://existing.db",
    format: "yane2016" as const,
    moves: [{ usi: "7g7f", comment: "existing", repetition: 0 }],
    closing: false,
    isUnsaved: false,
  };
  const newBook = {
    sessionId: undefined,
    path: undefined,
    format: "yane2016" as const,
    moves: [{ usi: "7g7f", comment: "new", repetition: 0 }],
    closing: false,
    isUnsaved: false,
  };
  const confirmationShowMock = vi.fn();
  return {
    newBook,
    storeMock: {
      appState: "normal",
      isMovableByUser: true,
      record: undefined as unknown as Record,
      showAddBookMovesDialog: vi.fn(),
    },
    confirmationShowMock,
    bookStoreMock: {
      hasActiveBook: true,
      books: [existingBook],
      activeBookId: "existing" as string | undefined,
      isNewBookOpen: true,
      newBook,
      setActiveBook: vi.fn(),
      activateNewBook: vi.fn(),
      closeBook: vi.fn(),
      closeNewBook: vi.fn(),
      reset: vi.fn(),
      openBookFile: vi.fn(),
      saveBookFileAs: vi.fn(),
      reloadBookMoves: vi.fn(),
      removeMove: vi.fn(),
      updateMoveOrder: vi.fn(),
      updateMove: vi.fn(),
    },
  };
});

vi.mock("@/renderer/store", () => ({
  useStore: () => storeMock,
}));
vi.mock("@/renderer/store/book", () => ({
  useBookStore: () => bookStoreMock,
}));
vi.mock("@/renderer/store/settings", () => ({
  useAppSettings: () => ({ flippedBook: false, updateAppSettings: vi.fn() }),
}));
vi.mock("@/renderer/store/confirm", () => ({
  useConfirmationStore: () => ({ show: confirmationShowMock }),
}));
vi.mock("@/renderer/store/error", () => ({
  useErrorStore: () => ({ add: vi.fn() }),
}));

describe("BookPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.record = new Record();
  });

  it("edits a move in the session belonging to the operated column", async () => {
    const wrapper = shallowMount(BookPanel);
    const columns = wrapper.findAllComponents(BookComparisonColumn);
    const move = storeMock.record.position.createMoveByUSI("7g7f")!;

    columns[1].vm.$emit("edit", newBook, move);
    await nextTick();
    const dialog = wrapper.getComponent(BookMoveDialog);
    expect(dialog.props("comment")).toBe("new");

    dialog.vm.$emit("ok", { comment: "updated" });
    await vi.waitFor(() =>
      expect(bookStoreMock.updateMove).toHaveBeenCalledWith(
        storeMock.record.position.sfen,
        { usi: "7g7f", comment: "updated" },
        undefined,
      ),
    );
    wrapper.unmount();
  });

  it("removes a move from the session belonging to the operated column", () => {
    const wrapper = shallowMount(BookPanel);
    const columns = wrapper.findAllComponents(BookComparisonColumn);
    const move = storeMock.record.position.createMoveByUSI("7g7f")!;

    columns[1].vm.$emit("remove", newBook, move);
    const confirmation = confirmationShowMock.mock.calls[0][0] as { onOk: () => void };
    confirmation.onOk();

    expect(bookStoreMock.removeMove).toHaveBeenCalledWith(
      storeMock.record.position.sfen,
      move.usi,
      undefined,
    );
    wrapper.unmount();
  });

  it("orders a move in the session belonging to the operated column", () => {
    const wrapper = shallowMount(BookPanel);
    const columns = wrapper.findAllComponents(BookComparisonColumn);
    const move = storeMock.record.position.createMoveByUSI("7g7f")!;

    columns[1].vm.$emit("order", newBook, move, 0);

    expect(bookStoreMock.updateMoveOrder).toHaveBeenCalledWith(
      storeMock.record.position.sfen,
      move.usi,
      0,
      undefined,
    );
    wrapper.unmount();
  });
});
