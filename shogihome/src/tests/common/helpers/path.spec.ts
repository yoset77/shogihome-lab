import { trimTrailingPathSeparators } from "@/common/helpers/path";

describe("trimTrailingPathSeparators", () => {
  it.each([
    ["", ""],
    ["server://", "server://"],
    ["server://games", "server://games"],
    ["server://games///", "server://games"],
    ["server://games\\\\", "server://games"],
    ["games/", "games"],
    ["server://../", "server://.."],
  ])("normalizes %s without corrupting the server URI", (input, expected) => {
    expect(trimTrailingPathSeparators(input)).toBe(expected);
    expect(trimTrailingPathSeparators(expected)).toBe(expected);
  });
});
