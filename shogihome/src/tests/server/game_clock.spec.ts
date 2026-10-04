import { Clock } from "@/server/game/clock";

describe("authoritative game clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("settles elapsed monotonic time before the timer wakes", () => {
    vi.useFakeTimers();
    let now = 0;
    const timeout = vi.fn();
    const clock = new Clock(() => now);
    clock.setup({ timeMs: 1000, byoyomi: 0, onTimeout: timeout });
    clock.start();
    now = 1001;
    clock.settle();
    clock.settle();
    expect(timeout).toHaveBeenCalledOnce();
    expect(clock.running).toBe(false);
    expect(clock.timeMs).toBe(0);
  });
  it("preserves exact remaining byoyomi and elapsed time through repeated pause/resume", () => {
    let now = 0;
    const clock = new Clock(() => now);
    clock.setup({ timeMs: 1000, byoyomi: 10, increment: 0 });
    clock.start();
    now = 3250;
    clock.pause();
    expect(clock.snapshot()).toEqual({ timeMs: 0, byoyomi: 8, byoyomiMs: 7750, elapsedMs: 3250 });
    now = 100_000;
    clock.resume();
    now += 750;
    clock.pause();
    expect(clock.snapshot()).toEqual({ timeMs: 0, byoyomi: 7, byoyomiMs: 7000, elapsedMs: 4000 });
    clock.resume();
    now += 1000;
    clock.stop();
    expect(clock.elapsedMs).toBe(5000);
    clock.start();
    expect(clock.byoyomi).toBe(10);
    clock.pause();
  });
  it("adds increments only on a completed move and restores checkpoints without another increment", () => {
    let now = 0;
    const clock = new Clock(() => now);
    clock.setup({ timeMs: 30_000, increment: 2 });
    const checkpoint = clock.snapshot();
    clock.start();
    now = 1250;
    clock.stop();
    expect(clock.timeMs).toBe(30_750);
    expect(clock.elapsedMs).toBe(1250);
    clock.restore(checkpoint);
    expect(clock.timeMs).toBe(30_000);
    expect(clock.elapsedMs).toBe(0);
  });
  it("ignores changes to the wall clock", () => {
    vi.useFakeTimers();
    let monotonic = 0;
    const clock = new Clock(() => monotonic);
    clock.setup({ timeMs: 10_000 });
    clock.start();
    vi.setSystemTime(Date.now() + 86_400_000);
    monotonic = 500;
    expect(clock.timeMs).toBe(9500);
    clock.pause();
  });
});
