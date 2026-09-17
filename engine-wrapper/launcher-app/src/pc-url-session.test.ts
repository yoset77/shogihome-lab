import { describe, expect, it } from "vitest";
import { PcUrlSession } from "./pc-url-session";

describe("PcUrlSession", () => {
  it("keeps only the latest refresh", () => {
    const session = new PcUrlSession();
    const first = session.next();
    expect(session.isCurrent(first)).toBe(true);
    const second = session.next();
    expect(session.isCurrent(first)).toBe(false);
    expect(session.isCurrent(second)).toBe(true);
  });
});
