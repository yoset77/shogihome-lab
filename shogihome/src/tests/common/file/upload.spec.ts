import { describe, expect, it } from "vitest";
import { isValidServerEntryName } from "@/common/file/upload";

describe("server file entry names", () => {
  it.each(["game.kif", "Book 2026", "\u68cb\u8b5c", "a".repeat(250)])("allows %j", (name) => {
    expect(isValidServerEntryName(name)).toBe(true);
  });

  it.each([
    "",
    ".",
    "..",
    ".hidden",
    "../escape",
    "a/b",
    "a\\b",
    "C:drive",
    "a\u0000b",
    "a\nb",
    "a\u007fb",
    "a?b",
    "a*b",
    "a|b",
    "a<b",
    'a"b',
    " leading",
    "trailing ",
    "trailing.",
    "CON",
    "nul.kif",
    "LPT1",
    "com9.db",
    "a".repeat(251),
    "\u68cb".repeat(84),
  ])("rejects %j", (name) => {
    expect(isValidServerEntryName(name)).toBe(false);
  });
});
