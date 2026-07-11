import { describe, expect, it } from "vitest";
import { Color } from "tsshogi";
import { EvaluationViewFrom } from "@/common/settings/app";
import { getDisplayEvaluation } from "@/renderer/helpers/evaluation";

describe("renderer/helpers/evaluation", () => {
  it("keeps the score and bound for side-to-move display", () => {
    expect(getDisplayEvaluation(100, Color.WHITE, EvaluationViewFrom.EACH, true, false)).toEqual({
      score: 100,
      lowerBound: true,
      upperBound: false,
      scoreFlag: "++",
    });
  });

  it("negates the score and swaps bounds for black display", () => {
    expect(getDisplayEvaluation(100, Color.WHITE, EvaluationViewFrom.BLACK, true, false)).toEqual({
      score: -100,
      lowerBound: false,
      upperBound: true,
      scoreFlag: "--",
    });
  });
});
