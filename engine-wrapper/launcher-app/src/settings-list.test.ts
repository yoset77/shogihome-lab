import { describe, expect, it } from "vitest";
import { choiceOptions, joinListValue, splitListValue } from "./settings-list";

describe("settings list helpers", () => {
  it("splits comma-joined values and drops empties", () => {
    expect(splitListValue("a.com, b.com ,,c.com")).toEqual(["a.com", "b.com", "c.com"]);
    expect(splitListValue("")).toEqual([]);
    expect(splitListValue(undefined)).toEqual([]);
  });

  it("joins rows preserving order without empties", () => {
    expect(joinListValue(["a.com", "  ", "b.com"])).toBe("a.com,b.com");
    expect(joinListValue([])).toBe("");
  });

  it("round-trips through split/join", () => {
    const raw = "sunfish-shogi.github.io,live4.computer-shogi.org";
    expect(joinListValue(splitListValue(raw))).toBe(raw);
  });

  it("preserves an existing custom choice value", () => {
    expect(choiceOptions(["0.0.0.0", "127.0.0.1"], "192.168.1.10")).toEqual([
      "192.168.1.10",
      "0.0.0.0",
      "127.0.0.1",
    ]);
    expect(choiceOptions(["0.0.0.0", "127.0.0.1"], "127.0.0.1")).toEqual([
      "0.0.0.0",
      "127.0.0.1",
    ]);
    expect(choiceOptions(["0.0.0.0", "127.0.0.1"], "")).toEqual(["0.0.0.0", "127.0.0.1"]);
  });
});
