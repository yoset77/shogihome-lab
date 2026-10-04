import { Color } from "tsshogi";
import { gameGoCommand } from "@/common/game/usi_time";

it("sends remaining server time and the future increment without subtracting earned time", () => {
  const times = {
    black: { timeMs: 30_000, increment: 2, byoyomi: 0 },
    white: { timeMs: 60_000, increment: 3, byoyomi: 0 },
  };
  expect(gameGoCommand(Color.BLACK, times)).toBe("go btime 30000 wtime 60000 binc 2000 winc 3000");
  times.black.timeMs = 30_750;
  expect(gameGoCommand(Color.WHITE, times)).toBe("go btime 30750 wtime 60000 binc 2000 winc 3000");
});
