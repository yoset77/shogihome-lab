import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppState } from "@/common/control/state";
import { FileQuickAction } from "@/common/settings/app";
import {
  getFileQuickAction,
  isFileQuickActionEnabled,
  runFileQuickAction,
} from "@/renderer/helpers/fileQuickAction";

const { isNativeMock } = vi.hoisted(() => ({ isNativeMock: vi.fn(() => false) }));
vi.mock("@/renderer/ipc/api", () => ({ isNative: isNativeMock }));

const storeMock = {
  appState: AppState.NORMAL as AppState,
  isServerSideKifuEnabled: true,
  startPuzzle: vi.fn(),
  openRecord: vi.fn(),
  showServerKifuDialog: vi.fn(),
  showRecordFileHistoryDialog: vi.fn(),
  showElapsedTimeChartDialog: vi.fn(),
};
const store = storeMock as unknown as Parameters<typeof runFileQuickAction>[1];

describe("file quick actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.appState = AppState.NORMAL;
    storeMock.isServerSideKifuEnabled = true;
    isNativeMock.mockReturnValue(false);
  });

  it.each([
    [FileQuickAction.PUZZLE, "startPuzzle"],
    [FileQuickAction.OPEN, "openRecord"],
    [FileQuickAction.LOAD_FROM_SERVER, "showServerKifuDialog"],
    [FileQuickAction.HISTORY, "showRecordFileHistoryDialog"],
    [FileQuickAction.ELAPSED_TIME_CHART, "showElapsedTimeChartDialog"],
  ] as const)("dispatches %s to the same operation as FileMenu", (action, method) => {
    expect(getFileQuickAction(action).label()).toBeTruthy();
    expect(isFileQuickActionEnabled(action, store)).toBe(true);

    runFileQuickAction(action, store);

    expect(store[method]).toHaveBeenCalledOnce();
  });

  it("disables actions in non-normal states and guards execution", () => {
    storeMock.appState = AppState.GAME;

    for (const action of Object.values(FileQuickAction)) {
      expect(isFileQuickActionEnabled(action, store)).toBe(false);
      runFileQuickAction(action, store);
    }

    expect(store.startPuzzle).not.toHaveBeenCalled();
    expect(store.openRecord).not.toHaveBeenCalled();
    expect(store.showServerKifuDialog).not.toHaveBeenCalled();
    expect(store.showRecordFileHistoryDialog).not.toHaveBeenCalled();
    expect(store.showElapsedTimeChartDialog).not.toHaveBeenCalled();
  });

  it("disables the server action without server kifu support", () => {
    storeMock.isServerSideKifuEnabled = false;
    expect(isFileQuickActionEnabled(FileQuickAction.LOAD_FROM_SERVER, store)).toBe(false);
    runFileQuickAction(FileQuickAction.LOAD_FROM_SERVER, store);
    expect(store.showServerKifuDialog).not.toHaveBeenCalled();

    storeMock.isServerSideKifuEnabled = true;
    isNativeMock.mockReturnValue(true);
    expect(isFileQuickActionEnabled(FileQuickAction.LOAD_FROM_SERVER, store)).toBe(false);
  });
});
