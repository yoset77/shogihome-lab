import { t } from "@/common/i18n";
import { useToastStore } from "@/renderer/store/toast";

/** Notify transitions, not individual retry attempts. */
export class ConnectionNotification {
  private interrupted = false;
  private toastId?: number;

  constructor(private readonly key: string) {}

  lost(): void {
    if (this.interrupted) return;
    this.interrupted = true;
    this.toastId = useToastStore().warning(t.connectionLostRetrying, { key: this.key });
  }

  restored(): void {
    if (!this.interrupted) return;
    this.interrupted = false;
    useToastStore().success(t.reconnected, { key: this.key });
  }

  reset(): void {
    if (this.interrupted && this.toastId !== undefined) useToastStore().dismiss(this.toastId);
    this.interrupted = false;
    this.toastId = undefined;
  }
}
