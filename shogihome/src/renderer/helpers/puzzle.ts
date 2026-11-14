import { AppState } from "@/common/control/state";

export function isEvaluationPuzzleState(
  appState: AppState,
  puzzle: { type?: string } | null | undefined,
): boolean {
  return appState === AppState.PUZZLE && puzzle?.type === "evaluation";
}
