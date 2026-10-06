import { generateSessionId } from "@/renderer/helpers/unique";

// A document-local guard supplements server generations when sessionStorage is copied.
export class JobTabGuard {
  private releaseLock?: () => void;
  private channel?: BroadcastChannel;
  private name?: string;
  private requestedName?: string;
  private pending?: Promise<boolean>;
  private generation = 0;
  private readonly documentId = generateSessionId();

  acquire(name: string): Promise<boolean> {
    if (this.name === name) return Promise.resolve(true);
    if (this.requestedName === name && this.pending) return this.pending;
    this.release();
    this.requestedName = name;
    const generation = this.generation;
    this.pending = this.request(name, generation);
    return this.pending;
  }

  private async request(name: string, generation: number): Promise<boolean> {
    if (navigator.locks) {
      return new Promise<boolean>((resolve, reject) => {
        void navigator.locks
          .request(name, { ifAvailable: true }, async (lock) => {
            if (!lock || generation !== this.generation) {
              resolve(false);
              return;
            }
            this.name = name;
            const held = new Promise<void>((done) => {
              this.releaseLock = done;
            });
            resolve(true);
            await held;
          })
          .catch(reject);
      });
    }
    // BroadcastChannel also works on private-network HTTP origins without Web Locks.
    if (!window.BroadcastChannel) return false;
    const channel = (this.channel = new window.BroadcastChannel(name));
    let occupied = false;
    const contenders = new Set<string>();
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("id" in data) ||
        typeof data.id !== "string" ||
        !("type" in data)
      )
        return;
      if (data.type === "probe") {
        if (this.name === name) channel.postMessage({ type: "held", id: this.documentId });
        else {
          contenders.add(data.id);
          channel.postMessage({ type: "candidate", id: this.documentId });
        }
      } else if (data.type === "held") occupied = true;
      else if (data.type === "candidate") contenders.add(data.id);
    };
    channel.postMessage({ type: "probe", id: this.documentId });
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    if (
      generation !== this.generation ||
      this.channel !== channel ||
      occupied ||
      [...contenders].some((id) => id < this.documentId)
    ) {
      if (this.channel === channel) this.release();
      return false;
    }
    this.name = name;
    channel.postMessage({ type: "held", id: this.documentId });
    return true;
  }

  release(): void {
    ++this.generation;
    this.name = undefined;
    this.requestedName = undefined;
    this.pending = undefined;
    this.releaseLock?.();
    this.releaseLock = undefined;
    this.channel?.close();
    this.channel = undefined;
  }
}

const guards = new Map<string, JobTabGuard>();
function guard(kind: string): JobTabGuard {
  let guard = guards.get(kind);
  if (!guard) {
    guard = new JobTabGuard();
    guards.set(kind, guard);
  }
  return guard;
}
function name(
  kind: string,
  value: { serverInstanceId: string; requestId: string; ownerId?: string; controllerId?: string },
): string {
  return `shogihome-attachment:${kind}:${value.serverInstanceId}:${value.requestId}:${value.ownerId ?? value.controllerId}`;
}
export async function guardJobRecovery(kind: "analysis" | "game"): Promise<boolean> {
  const raw = sessionStorage.getItem(`shogihome-job-attachment:${kind}`);
  if (!raw) return true;
  const value = JSON.parse(raw);
  return guard(kind).acquire(name(kind, value));
}
export function holdJobTab(
  kind: string,
  value: { serverInstanceId: string; requestId: string; ownerId?: string; controllerId?: string },
): void {
  void guard(kind)
    .acquire(name(kind, value))
    .catch(() => {});
}
export function releaseJobTab(kind: string): void {
  guards.get(kind)?.release();
}
