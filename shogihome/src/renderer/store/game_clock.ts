import type { GameClock } from "@/common/game/protocol";

/** Display-only interpolation; it never decides timeout or changes server time. */
export class GameClockDisplay {
  private sample: GameClock = { timeMs: 0, byoyomiMs: 0, elapsedMs: 0, running: false };
  private receivedAt = 0;
  constructor(private readonly now = () => performance.now()) {}
  update(value: GameClock): void {
    this.sample = { ...value };
    this.receivedAt = this.now();
  }
  private value(): GameClock {
    const elapsed = this.sample.running
      ? Math.min(1500, Math.max(0, this.now() - this.receivedAt))
      : 0;
    return {
      ...this.sample,
      timeMs: Math.max(0, this.sample.timeMs - elapsed),
      byoyomiMs: Math.max(0, this.sample.byoyomiMs - Math.max(0, elapsed - this.sample.timeMs)),
      elapsedMs: this.sample.elapsedMs + elapsed,
    };
  }
  get time(): number {
    return Math.ceil(this.value().timeMs / 1000);
  }
  get byoyomi(): number {
    return Math.ceil(this.value().byoyomiMs / 1000);
  }
  pause(): void {
    this.update({ ...this.value(), running: false });
  }
}
