import { describe, expect, it } from "vitest";
import { Position } from "tsshogi";
import { formatDisplayPV } from "@/renderer/helpers/pv";
import { Language, setLanguage } from "@/common/i18n";

describe("renderer/helpers/pv", () => {
  const position = Position.newBySFEN(
    "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
  );

  it.each([
    ["rep_draw", "千日手"],
    ["rep_win", "連続王手の千日手"],
    ["rep_lose", "連続王手の千日手"],
    ["rep_sup", "優等局面"],
    ["rep_inf", "劣等局面"],
    ["win", "宣言勝ち"],
    ["resign", "投了"],
  ])("formats %s as a parenthesized label, not an unread move", (end, label) => {
    const result = formatDisplayPV(position!, ["7g7f", end], 1);
    expect(result.parsedPv.map((move) => move.usi)).toEqual(["7g7f"]);
    expect(result.text).toBe(`☗７六歩 （${label}）`);
    expect(formatDisplayPV(position!, [end], 1)).toEqual({
      parsedPv: [],
      text: `（${label}）`,
    });
  });

  it("preserves the ending when the displayed move text is truncated", () => {
    const result = formatDisplayPV(position!, ["7g7f", "3c3d", "rep_draw"], 1);
    expect(result.parsedPv).toHaveLength(2);
    expect(result.text).toBe("☗７六歩 ... （千日手）");
  });

  it("does not display an ending beyond an invalid or misplaced token", () => {
    for (const pv of [
      ["7g7f", "invalid", "rep_draw"],
      ["7g7f", "rep_draw", "3c3d"],
    ])
      expect(formatDisplayPV(position!, pv, 10).text).toBe("☗７六歩 ...");
  });

  it("uses the current translation for PV endings", () => {
    setLanguage(Language.EN);
    try {
      expect(formatDisplayPV(position!, ["resign"], 10).text).toBe("(Resign)");
    } finally {
      setLanguage(Language.JA);
    }
  });

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
