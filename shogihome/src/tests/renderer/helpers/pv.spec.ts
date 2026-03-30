import { describe, expect, it } from "vitest";
import { Position } from "tsshogi";
import { formatDisplayPV } from "@/renderer/helpers/pv";

describe("renderer/helpers/pv", () => {
  const position = Position.newBySFEN(
    "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
  );

  it("truncates PV text at formatting time", () => {
    const result = formatDisplayPV(position!, ["7g7f", "3c3d", "2g2f"], 2);

    expect(result.parsedPv).toHaveLength(3);
    expect(result.text).toMatch(/ \.\.\.$/);
  });

  it("appends ellipsis when parsing stops with unread moves remaining", () => {
    const result = formatDisplayPV(position!, ["7g7f", "3c3d", "invalidmove"], 2);

    expect(result.parsedPv).toHaveLength(2);
    expect(result.text.endsWith(" ...")).toBe(true);
  });

  it("does not append ellipsis when the first move cannot be parsed", () => {
    const result = formatDisplayPV(position!, ["invalidmove"], 2);

    expect(result.parsedPv).toHaveLength(0);
    expect(result.text).toBe("");
  });
});
