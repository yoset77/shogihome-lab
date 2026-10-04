import { Color } from "tsshogi";
import type { TimeStates } from "./time";

export function gameGoCommand(color: Color, times: TimeStates): string {
  const byoyomi = times[color].byoyomi;
  const btime = Math.floor(Math.max(0, times.black.timeMs));
  const wtime = Math.floor(Math.max(0, times.white.timeMs));
  let command = `go btime ${btime} wtime ${wtime}`;
  if (byoyomi > 0) command += ` byoyomi ${byoyomi * 1000}`;
  else if (times.black.increment || times.white.increment)
    command += ` binc ${times.black.increment * 1000} winc ${times.white.increment * 1000}`;
  return command;
}
