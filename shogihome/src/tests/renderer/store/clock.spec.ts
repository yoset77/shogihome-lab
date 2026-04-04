import { Clock } from "@/renderer/store/clock.js";

describe("store/clock", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("simple", () => {
    const settings = {
      timeMs: 300 * 1e3,
      byoyomi: 0,
      increment: 0,
      onBeepShort: vi.fn(),
      onBeepUnlimited: vi.fn(),
      onStopBeep: vi.fn(),
      onTimeout: vi.fn(),
    };
    const clock = new Clock();
    clock.setup(settings);
    clock.start();
    // 5:00
    expect(clock.timeMs).toBe(300 * 1e3);
    expect(clock.byoyomi).toBe(0);
    expect(settings.onStopBeep).toBeCalledTimes(1);
    vi.advanceTimersByTime(239 * 1e3);
    // 1:01
    expect(clock.timeMs).toBe(61 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(0);
    vi.advanceTimersByTime(1 * 1e3);
    // 1:00
    expect(clock.timeMs).toBe(60 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(1);
    vi.advanceTimersByTime(29 * 1e3);
    // 0:31
    expect(clock.timeMs).toBe(31 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(1);
    vi.advanceTimersByTime(1 * 1e3);
    // 0:30
    expect(clock.timeMs).toBe(30 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(2);
    vi.advanceTimersByTime(20 * 1e3);
    // 0:10
    expect(clock.timeMs).toBe(10 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(4);
    vi.advanceTimersByTime(4 * 1e3);
    // 0:06
    expect(clock.timeMs).toBe(6 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(8);
    expect(settings.onBeepUnlimited).toBeCalledTimes(0);
    vi.advanceTimersByTime(1 * 1e3);
    // 0:05
    expect(clock.timeMs).toBe(5 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(8);
    expect(settings.onBeepUnlimited).toBeCalledTimes(1);
    vi.advanceTimersByTime(4 * 1e3);
    // 0:01
    expect(clock.timeMs).toBe(1 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(8);
    expect(settings.onStopBeep).toBeCalledTimes(1);
    expect(settings.onTimeout).toBeCalledTimes(0);
    vi.advanceTimersByTime(1 * 1e3);
    // 0:00
    expect(clock.timeMs).toBe(0 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(8);
    expect(settings.onStopBeep).toBeCalledTimes(2);
    expect(settings.onTimeout).toBeCalledTimes(1);
  });

  it("byoyomi", () => {
    const settings = {
      timeMs: 300 * 1e3,
      byoyomi: 60,
      increment: 0,
      onBeepShort: vi.fn(),
      onBeepUnlimited: vi.fn(),
      onStopBeep: vi.fn(),
      onTimeout: vi.fn(),
    };
    const clock = new Clock();
    clock.setup(settings);
    clock.start();
    // 5:00 - 60
    expect(clock.timeMs).toBe(300 * 1e3);
    expect(clock.byoyomi).toBe(60);
    expect(settings.onStopBeep).toBeCalledTimes(1);
    vi.advanceTimersByTime(299 * 1e3);
    // 0:01 - 60
    expect(clock.timeMs).toBe(1 * 1e3);
    expect(clock.byoyomi).toBe(60);
    expect(settings.onBeepShort).toBeCalledTimes(0);
    vi.advanceTimersByTime(1 * 1e3);
    // 0:00 - 60
    expect(clock.timeMs).toBe(0 * 1e3);
    expect(clock.byoyomi).toBe(60);
    expect(settings.onBeepShort).toBeCalledTimes(1);
    vi.advanceTimersByTime(29 * 1e3);
    // 0:00 - 31
    expect(clock.timeMs).toBe(0 * 1e3);
    expect(clock.byoyomi).toBe(31);
    expect(settings.onBeepShort).toBeCalledTimes(1);
    vi.advanceTimersByTime(1 * 1e3);
    // 0:00 - 30
    expect(clock.timeMs).toBe(0 * 1e3);
    expect(clock.byoyomi).toBe(30);
    expect(settings.onBeepShort).toBeCalledTimes(2);
    vi.advanceTimersByTime(20 * 1e3);
    // 0:00 - 10
    expect(clock.timeMs).toBe(0 * 1e3);
    expect(clock.byoyomi).toBe(10);
    expect(settings.onBeepShort).toBeCalledTimes(4);
    vi.advanceTimersByTime(4 * 1e3);
    // 0:00 - 06
    expect(clock.timeMs).toBe(0 * 1e3);
    expect(clock.byoyomi).toBe(6);
    expect(settings.onBeepShort).toBeCalledTimes(8);
    expect(settings.onBeepUnlimited).toBeCalledTimes(0);
    vi.advanceTimersByTime(1 * 1e3);
    // 0:00 - 05
    expect(clock.timeMs).toBe(0 * 1e3);
    expect(clock.byoyomi).toBe(5);
    expect(settings.onBeepShort).toBeCalledTimes(8);
    expect(settings.onBeepUnlimited).toBeCalledTimes(1);
    vi.advanceTimersByTime(4 * 1e3);
    // 0:00 - 01
    expect(clock.timeMs).toBe(0 * 1e3);
    expect(clock.byoyomi).toBe(1);
    expect(settings.onBeepShort).toBeCalledTimes(8);
    expect(settings.onStopBeep).toBeCalledTimes(1);
    expect(settings.onTimeout).toBeCalledTimes(0);
    vi.advanceTimersByTime(1 * 1e3);
    // 0:00 - 00
    expect(clock.timeMs).toBe(0 * 1e3);
    expect(clock.byoyomi).toBe(0);
    expect(settings.onBeepShort).toBeCalledTimes(8);
    expect(settings.onStopBeep).toBeCalledTimes(2);
    expect(settings.onTimeout).toBeCalledTimes(1);
  });

  it("increment", () => {
    const settings = {
      timeMs: 300 * 1e3,
      byoyomi: 0,
      increment: 5,
      onBeepShort: vi.fn(),
      onBeepUnlimited: vi.fn(),
      onStopBeep: vi.fn(),
      onTimeout: vi.fn(),
    };
    const clock = new Clock();
    clock.setup(settings);
    clock.start();
    // 5:00
    expect(clock.timeMs).toBe(300 * 1e3);
    expect(clock.byoyomi).toBe(0);
    expect(settings.onStopBeep).toBeCalledTimes(1);
    vi.advanceTimersByTime(200 * 1e3);
    // 1:40
    expect(clock.timeMs).toBe(100 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(0);
    clock.stop();
    // 1:45
    expect(clock.timeMs).toBe(105 * 1e3);
    expect(settings.onStopBeep).toBeCalledTimes(2);
    clock.start();
    expect(settings.onStopBeep).toBeCalledTimes(3);
    vi.advanceTimersByTime(47 * 1e3);
    // 0:58
    expect(clock.timeMs).toBe(58 * 1e3);
    expect(settings.onBeepShort).toBeCalledTimes(1);
    clock.stop();
    // 1:03
    expect(clock.timeMs).toBe(63 * 1e3);
    expect(settings.onStopBeep).toBeCalledTimes(4);
  });

  it("correct", () => {
    const settings = {
      timeMs: 300 * 1e3,
      byoyomi: 60,
      increment: 0,
      onBeepShort: vi.fn(),
      onBeepUnlimited: vi.fn(),
      onStopBeep: vi.fn(),
      onTimeout: vi.fn(),
    };
    const clock = new Clock();
    clock.setup(settings);
    clock.start();

    // 5:00 - 60
    expect(clock.timeMs).toBe(300 * 1e3);
    expect(clock.byoyomi).toBe(60);

    vi.advanceTimersByTime(10 * 1e3);
    // 4:50 - 60
    expect(clock.timeMs).toBe(290 * 1e3);

    // Correct: -1000ms (Add 1s) -> 4:51
    clock.correct(-1000);
    expect(clock.timeMs).toBe(291 * 1e3);

    // Correct: +5000ms (Consume 5s) -> 4:46
    clock.correct(5000);
    expect(clock.timeMs).toBe(286 * 1e3);

    // Correct: +286000ms (Consume all time) -> 0:00 - 60
    clock.correct(286 * 1e3);
    expect(clock.timeMs).toBe(0);
    expect(clock.byoyomi).toBe(60);

    // Correct: +10000ms (Consume 10s of byoyomi) -> 0:00 - 50
    clock.correct(10000);
    expect(clock.timeMs).toBe(0);
    expect(clock.byoyomi).toBe(50);

    // Correct: -5000ms (Rewind 5s of byoyomi) -> 0:00 - 55
    clock.correct(-5000);
    expect(clock.timeMs).toBe(0);
    expect(clock.byoyomi).toBe(55);

    // Correct: -60000ms (Rewind 60s -> Back to main time)
    // Current Elapsed: 10(adv) - 1(cor) + 5(cor) + 286(cor) + 10(cor) - 5(cor) = 305s
    // Initial Time: 300s
    // Byoyomi: 60s
    // 305s elapsed -> 300s time consumed, 5s byoyomi consumed.
    // Rewind 60s -> 245s elapsed.
    // 300 - 245 = 55s remaining.
    clock.correct(-60000);
    expect(clock.timeMs).toBe(55 * 1e3);
    expect(clock.byoyomi).toBe(60);
  });

  it("correct with increment", () => {
    const settings = {
      timeMs: 300 * 1e3,
      byoyomi: 0,
      increment: 5,
      onBeepShort: vi.fn(),
      onBeepUnlimited: vi.fn(),
      onStopBeep: vi.fn(),
      onTimeout: vi.fn(),
    };
    const clock = new Clock();
    clock.setup(settings);
    clock.start();

    // 5:00
    expect(clock.timeMs).toBe(300 * 1e3);
    expect(clock.byoyomi).toBe(0);

    vi.advanceTimersByTime(2000);
    // 4:58
    expect(clock.timeMs).toBe(298 * 1e3);

    // correct: -1000ms delay -> 4:59
    clock.correct(-1000);
    expect(clock.timeMs).toBe(299 * 1e3);

    // stop -> add 5s increment -> 5:04
    clock.stop();
    expect(clock.timeMs).toBe(304 * 1e3);
  });
});
