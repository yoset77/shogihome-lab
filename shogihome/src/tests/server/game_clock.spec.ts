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
    clock.finishTurn();
    expect(clock.elapsedMs).toBe(5000);
    clock.start();
    expect(clock.byoyomi).toBe(10);
    clock.pause();
  });
  it("credits the first increment during setup and the next one after each completed turn", () => {
    let now = 0;
    const clock = new Clock(() => now);
    clock.setup({ timeMs: 30_000, increment: 2 });
    const checkpoint = clock.snapshot();
    expect(clock.timeMs).toBe(32_000);
    clock.start();
    expect(clock.timeMs).toBe(32_000);
    now = 1250;
    expect(clock.timeMs).toBe(30_750);
    clock.finishTurn();
    expect(clock.timeMs).toBe(32_750);
    expect(clock.elapsedMs).toBe(1250);
    clock.start();
    expect(clock.timeMs).toBe(32_750);
    clock.pause();
    clock.restore(checkpoint);
    expect(clock.timeMs).toBe(32_000);
    expect(clock.elapsedMs).toBe(0);
    clock.start();
    expect(clock.timeMs).toBe(32_000);
    clock.pause();
  });
  it("does not add another increment when resuming a paused or initially disconnected turn", () => {
    let now = 0;
    const clock = new Clock(() => now);
    clock.setup({ timeMs: 60_000, increment: 2 });
    clock.start(false);
    expect(clock.timeMs).toBe(62_000);
    now = 10_000;
    clock.resume();
    now += 1250;
    clock.pause();
    expect(clock.timeMs).toBe(60_750);
    now += 10_000;
    clock.resume();
    clock.resume();
    now += 750;
    clock.pause();
    expect(clock.timeMs).toBe(60_000);
    expect(clock.elapsedMs).toBe(2000);
  });
  it.each([0, 60_000])(
    "allows the first increment with %sms main time before timeout",
    (timeMs) => {
      let now = 0;
      const timeout = vi.fn();
      const clock = new Clock(() => now);
      clock.setup({ timeMs, increment: 2, onTimeout: timeout });
      clock.start();
      now = timeMs + 1;
      clock.settle();
      expect(timeout).not.toHaveBeenCalled();
      expect(clock.timeMs).toBe(1999);
      now = timeMs + 2001;
      clock.settle();
      expect(timeout).toHaveBeenCalledOnce();
      expect(clock.running).toBe(false);
    },
  );
  it("resets the first increment for a new game", () => {
    const clock = new Clock(() => 0);
    for (let game = 0; game < 2; game++) {
      clock.setup({ timeMs: 60_000, increment: 2 });
      expect(clock.timeMs).toBe(62_000);
      clock.start();
      expect(clock.timeMs).toBe(62_000);
      clock.finishTurn();
      expect(clock.timeMs).toBe(64_000);
    }
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
