import { reactive } from "vue";
import { useStore } from "@/renderer/store";
import { useBookStore } from "@/renderer/store/book";
import { useBusyState } from "@/renderer/store/busy";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useErrorStore } from "@/renderer/store/error";
import { useMessageStore } from "@/renderer/store/message";
import { useFileSaveStore } from "@/renderer/store/fileSave";
import { clearURLParams, flushRecordForWebApp } from "@/renderer/store/webapp";

export type UpdateDependencies = {
  canReload: () => boolean;
  persist: (options: { forReload: boolean }) => void;
  reload: () => void;
};

export class PwaUpdateStore {
  available = false;
  expanded = true;
  applying = false;
  failed = false;
  dialogOpen = false;
  private reloadReady = false;
  private updater?: () => Promise<void>;
  private timer?: number;

  constructor(private dependencies: UpdateDependencies) {}

  get canApply(): boolean {
    return !this.applying && !this.dialogOpen && this.dependencies.canReload();
  }

  setUpdater(updater: () => Promise<void>): void {
    this.updater = updater;
  }

  private notify(): void {
    if (!this.available) this.expanded = true;
    // A fresh update supersedes any failure from the previous attempt.
    this.failed = false;
    this.available = true;
  }

  onNeedRefresh(): void {
    this.reloadReady = false;
    this.notify();
  }

  onNeedReload(): void {
    this.reloadReady = true;
    this.notify();
    // Another tab may activate the worker, but cannot authorize this tab to reload.
    if (this.applying) this.finishReload();
  }

  // Hide the notice without discarding the update: the menu can show it again.
  dismiss(): void {
    if (!this.available || this.applying) return;
    this.expanded = false;
  }

  show(): void {
    if (!this.available) return;
    this.expanded = true;
  }

  async apply(): Promise<void> {
    if (!this.available || !this.canApply) return;
    this.failed = false;
    try {
      this.dependencies.persist({ forReload: false });
      this.applying = true;
      if (this.reloadReady) {
        this.finishReload();
        return;
      }
      if (!this.updater) throw new Error("Service worker is not registered");
      this.timer = window.setTimeout(() => this.fail(), 10_000);
      await this.updater();
    } catch {
      this.fail();
    }
  }

  private finishReload(): void {
    this.clearTimer();
    this.applying = false;
    // Recheck and flush the latest edits after the asynchronous activation.
    if (this.dialogOpen || !this.dependencies.canReload()) return;
    try {
      this.dependencies.persist({ forReload: true });
      this.dependencies.reload();
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    this.clearTimer();
    this.applying = false;
    this.failed = true;
    this.expanded = true;
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.clearTimer();
    this.applying = false;
  }
}

export const createPwaUpdateStore = (dependencies: UpdateDependencies) =>
  reactive(new PwaUpdateStore(dependencies));

export function createWebUpdateDependencies(
  reload: () => void = () => window.location.reload(),
): UpdateDependencies {
  return {
    canReload: () =>
      useStore().canReloadForUpdate &&
      !useBookStore().hasUnsavedBooks &&
      !useBusyState().isBusy &&
      !useConfirmationStore().message &&
      !useErrorStore().hasError &&
      !useMessageStore().hasMessage &&
      !useFileSaveStore().options &&
      !document.querySelector("dialog[open]"),
    persist: ({ forReload }) => {
      // Preserve shared records without losing their URL if saving fails.
      flushRecordForWebApp(useStore().record, { force: true });
      if (forReload) clearURLParams();
    },
    reload,
  };
}

let store: ReturnType<typeof createPwaUpdateStore>;
export function usePwaUpdateStore(): ReturnType<typeof createPwaUpdateStore> {
  return (store ??= createPwaUpdateStore(createWebUpdateDependencies()));
}
