import { Color } from "tsshogi";
import { gameGoCommand } from "@/common/game/usi_time";

it("sends the pre-turn main time and each player's increment separately", () => {
  const times = {
    black: { timeMs: 30_000, increment: 2, byoyomi: 0 },
    white: { timeMs: 60_000, increment: 3, byoyomi: 0 },
  };
  expect(gameGoCommand(Color.BLACK, times)).toBe("go btime 30000 wtime 60000 binc 2000 winc 3000");
  times.black.timeMs = 30_750;
  expect(gameGoCommand(Color.WHITE, times)).toBe("go btime 30750 wtime 60000 binc 2000 winc 3000");
});

it("does not subtract an increment when the remaining main time is smaller than it", () => {
  const times = {
    black: { timeMs: 500, increment: 2, byoyomi: 0 },
    white: { timeMs: 0, increment: 3, byoyomi: 0 },
  };
  expect(gameGoCommand(Color.BLACK, times)).toBe("go btime 500 wtime 0 binc 2000 winc 3000");
});

it("sends byoyomi 0 explicitly when neither side has an increment", () => {
  const times = {
    black: { timeMs: 30_000.9, increment: 0, byoyomi: 0 },
    white: { timeMs: 60_000, increment: 0, byoyomi: 0 },
  };
  expect(gameGoCommand(Color.BLACK, times)).toBe("go btime 30000 wtime 60000 byoyomi 0");
});

it("uses the side to move's byoyomi instead of the opponent's increment", () => {
  const times = {
    black: { timeMs: 30_000, increment: 0, byoyomi: 10 },
    white: { timeMs: 60_000, increment: 3, byoyomi: 0 },
  };
  expect(gameGoCommand(Color.BLACK, times)).toBe("go btime 30000 wtime 60000 byoyomi 10000");
  expect(gameGoCommand(Color.WHITE, times)).toBe("go btime 30000 wtime 60000 binc 0 winc 3000");
});
