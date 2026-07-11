import { EvaluationViewFrom } from "@/common/settings/app";
import { Color } from "tsshogi";

export interface DisplayEvaluation {
  score: number;
  lowerBound: boolean;
  upperBound: boolean;
  scoreFlag: "" | "++" | "--";
}

export function getDisplayEvaluation(
  score: number,
  color: Color,
  viewFrom: EvaluationViewFrom,
  lowerBound = false,
  upperBound = false,
): DisplayEvaluation {
  const invert = viewFrom !== EvaluationViewFrom.EACH && color !== Color.BLACK;
  const displayLowerBound = invert ? upperBound : lowerBound;
  const displayUpperBound = invert ? lowerBound : upperBound;
  return {
    score: invert ? -score : score,
    lowerBound: displayLowerBound,
    upperBound: displayUpperBound,
    scoreFlag: displayLowerBound ? "++" : displayUpperBound ? "--" : "",
  };
}
