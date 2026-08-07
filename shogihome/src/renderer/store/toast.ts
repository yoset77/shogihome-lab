import { reactive, UnwrapNestedRefs } from "vue";

export type ToastType = "info" | "success" | "warning" | "error";

export type ToastEntry = {
  id: number;
  type: ToastType;
  message: string;
  count: number;
  key?: string;
};

export type ToastOptions = {
  durationMs?: number;
  key?: string;
};

export const TOAST_DURATION_MS: Record<ToastType, number> = {
  info: 2000,
  success: 2000,
  warning: 4000,
  error: 4000,
};

const MAX_TOASTS = 3;

export class ToastStore {
  private _toasts: ToastEntry[] = [];
  private timers = new Map<number, number>();
  private nextId = 1;

  get toasts(): ToastEntry[] {
    return this._toasts;
  }

  show(type: ToastType, message: string, options: ToastOptions = {}): number {
    const durationMs = options.durationMs ?? TOAST_DURATION_MS[type];
    const existingIndex = this._toasts.findIndex((toast) =>
      options.key !== undefined
        ? toast.key === options.key
        : toast.key === undefined && toast.type === type && toast.message === message,
    );
    const existing = this._toasts[existingIndex];
    if (existing) {
      const isDuplicate = existing.type === type && existing.message === message;
      existing.type = type;
      existing.message = message;
      existing.count = isDuplicate ? existing.count + 1 : 1;
      if (existingIndex !== this._toasts.length - 1) {
        this._toasts.splice(existingIndex, 1);
        this._toasts.push(existing);
      }
      this.scheduleDismiss(existing.id, durationMs);
      return existing.id;
    }

    const toast: ToastEntry = {
      id: this.nextId++,
      type,
      message,
      count: 1,
      key: options.key,
    };
    this._toasts.push(toast);
    while (this._toasts.length > MAX_TOASTS) {
      this.dismiss(this._toasts[0].id);
    }
    this.scheduleDismiss(toast.id, durationMs);
    return toast.id;
  }

  info(message: string, options?: ToastOptions): number {
    return this.show("info", message, options);
  }

  success(message: string, options?: ToastOptions): number {
    return this.show("success", message, options);
  }

  warning(message: string, options?: ToastOptions): number {
    return this.show("warning", message, options);
  }

  error(message: string, options?: ToastOptions): number {
    return this.show("error", message, options);
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.timers.delete(id);
    }
    this._toasts = this._toasts.filter((toast) => toast.id !== id);
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      window.clearTimeout(timer);
    }
    this.timers.clear();
    this._toasts = [];
  }

  private scheduleDismiss(id: number, durationMs: number): void {
    this.dismissTimer(id);
    const timer = window.setTimeout(() => {
      this.dismiss(id);
    }, durationMs);
    this.timers.set(id, timer);
  }

  private dismissTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}

export function createToastStore(): UnwrapNestedRefs<ToastStore> {
  return reactive(new ToastStore());
}

let store: UnwrapNestedRefs<ToastStore>;

export function useToastStore(): UnwrapNestedRefs<ToastStore> {
  if (!store) {
    store = createToastStore();
  }
  return store;
}
