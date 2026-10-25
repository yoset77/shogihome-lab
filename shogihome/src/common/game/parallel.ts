import * as v from "@/common/analysis/validation";
import { MAX_GAME_PARALLELISM } from "@/common/settings/game";
import { readGameResults, type GameResults } from "./results";

export type ParallelGameProgress = {
  parallelism: number;
  activeGames: number;
  results: GameResults;
  error?: "engine" | "capacity" | "save";
};

export function readParallelGameProgress(value: unknown): ParallelGameProgress {
  const input = v.object(value);
  const parallelism = v.counter(input.parallelism, MAX_GAME_PARALLELISM);
  if (parallelism < 2) throw new Error("Invalid parallel game count");
  return {
    parallelism,
    activeGames: v.counter(input.activeGames, parallelism),
    results: readGameResults(input.results),
    ...(input.error === undefined
      ? {}
      : { error: v.enumeration(input.error, ["engine", "capacity", "save"] as const) }),
  };
}
