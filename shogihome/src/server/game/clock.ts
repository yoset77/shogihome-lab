import { performance } from "node:perf_hooks";

export type ClockSettings = {
  timeMs?: number;
  byoyomi?: number;
  increment?: number;
  onTimeout?: () => void;
  onBeepShort?: () => void;
  onBeepUnlimited?: () => void;
  onStopBeep?: () => void;
};
export type ClockSnapshot = {
  timeMs: number;
  byoyomi: number;
  byoyomiMs: number;
  elapsedMs: number;
};

/** The monotonic clock is authoritative; timers only wake the owner. */
export class Clock {
  settings: ClockSettings = {};
  private value: ClockSnapshot = { timeMs: 0, byoyomi: 0, byoyomiMs: 0, elapsedMs: 0 };
  private startedAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private expired = false;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get running(): boolean {
    return !!this.timer;
  }
  get timeMs(): number {
    return this.snapshot().timeMs;
  }
  get time(): number {
    return Math.ceil(this.timeMs / 1000);
  }
  get byoyomi(): number {
    return this.snapshot().byoyomi;
  }
  get elapsedMs(): number {
    return this.snapshot().elapsedMs;
  }

  snapshot(): ClockSnapshot {
    const elapsed = this.running ? Math.max(0, this.now() - this.startedAt) : 0;
    const extra = Math.max(0, elapsed - this.value.timeMs);
    const byoyomiMs = Math.max(0, this.value.byoyomiMs - extra);
    return {
      timeMs: Math.max(0, this.value.timeMs - elapsed),
      byoyomi: Math.ceil(byoyomiMs / 1000),
      byoyomiMs,
      elapsedMs: this.value.elapsedMs + elapsed,
    };
  }
  setup(settings: ClockSettings): void {
    this.pause();
    this.settings = settings;
    const byoyomiMs = (settings.byoyomi ?? 0) * 1000;
    this.value = {
      timeMs: settings.timeMs ?? 0,
      byoyomi: settings.byoyomi ?? 0,
      byoyomiMs,
      elapsedMs: 0,
    };
    this.expired = false;
  }
  restore(value: ClockSnapshot): void {
    this.pause();
    this.value = { ...value };
    this.expired = false;
  }
  start(running = true): void {
    this.pause();
    this.value.elapsedMs = 0;
    this.value.byoyomiMs = (this.settings.byoyomi ?? 0) * 1000;
    this.value.byoyomi = this.settings.byoyomi ?? 0;
    this.expired = false;
    if (running) this.resume();
  }
  resume(): void {
    if (this.running || this.expired) return;
    this.startedAt = this.now();
    this.timer = setInterval(() => this.settle(), 100);
    this.timer.unref?.();
  }
  settle(): void {
    if (!this.running) return;
    const value = this.snapshot();
    if (value.timeMs === 0 && value.byoyomiMs === 0 && !this.expired) {
      this.pause();
      this.expired = true;
      this.settings.onTimeout?.();
    }
  }
  pause(): void {
    this.value = this.snapshot();
    clearInterval(this.timer);
    this.timer = undefined;
  }
  stop(): void {
    this.pause();
    this.value.timeMs += (this.settings.increment ?? 0) * 1000;
  }
}
