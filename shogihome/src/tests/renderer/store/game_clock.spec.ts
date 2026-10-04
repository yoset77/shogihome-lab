import { GameClockDisplay } from "@/renderer/store/game_clock";

it("interpolates display time without advancing past a bounded stale sample", () => {
  let now = 0;
  const clock = new GameClockDisplay(() => now);
  clock.update({ timeMs: 1000, byoyomiMs: 10_000, elapsedMs: 0, running: true });
  now = 1400;
  expect(clock.time).toBe(0);
  expect(clock.byoyomi).toBe(10);
  now = 1_000_000;
  expect(clock.byoyomi).toBe(10);
  clock.pause();
  now += 1_000_000;
  expect(clock.byoyomi).toBe(10);
  clock.update({ timeMs: 0, byoyomiMs: 6000, elapsedMs: 5000, running: false });
  expect(clock.byoyomi).toBe(6);
});
