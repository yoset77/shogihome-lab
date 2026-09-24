import { AppState } from "@/common/control/state";
import { t } from "@/common/i18n";
import { FileQuickAction } from "@/common/settings/app";
import { IconType } from "@/renderer/assets/icons";
import { isNative } from "@/renderer/ipc/api";
import type { useStore } from "@/renderer/store";

type Store = ReturnType<typeof useStore>;

type Action = {
  label: () => string;
  icon: IconType;
  enabled: (store: Store) => boolean;
  execute: (store: Store) => void;
};

const inNormalState = (store: Store) => store.appState === AppState.NORMAL;

const actions: Record<FileQuickAction, Action> = {
  [FileQuickAction.PUZZLE]: {
    label: () => t.puzzles,
    icon: IconType.QUESTION,
    enabled: inNormalState,
    execute: (store) => {
      store.startPuzzle();
    },
  },
  [FileQuickAction.OPEN]: {
    label: () => t.open,
    icon: IconType.OPEN,
    enabled: inNormalState,
    execute: (store) => {
      store.openRecord();
    },
  },
  [FileQuickAction.LOAD_FROM_SERVER]: {
    label: () => t.loadFromServer,
    icon: IconType.BATCH,
    enabled: (store) => !isNative() && store.isServerSideKifuEnabled && inNormalState(store),
    execute: (store) => {
      store.showServerKifuDialog();
    },
  },
  [FileQuickAction.HISTORY]: {
    label: () => t.history,
    icon: IconType.HISTORY,
    enabled: inNormalState,
    execute: (store) => {
      store.showRecordFileHistoryDialog();
    },
  },
  [FileQuickAction.ELAPSED_TIME_CHART]: {
    label: () => t.elapsedTimeChart,
    icon: IconType.HISTORY,
    enabled: inNormalState,
    execute: (store) => {
      store.showElapsedTimeChartDialog();
    },
  },
};

export function getFileQuickAction(action: FileQuickAction): Action {
  return actions[action];
}

export function isFileQuickActionEnabled(action: FileQuickAction, store: Store): boolean {
  return actions[action].enabled(store);
}

export function runFileQuickAction(action: FileQuickAction, store: Store): void {
  if (isFileQuickActionEnabled(action, store)) {
    actions[action].execute(store);
  }
}
