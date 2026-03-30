import { createBusyStore } from "@/renderer/store/busy.js";

describe("store/busy", () => {
  it("should ignore unmatched release calls", () => {
    const busy = createBusyStore();

    busy.release();

    expect(busy.isBusy).toBe(false);
    expect(busy.progress).toBeUndefined();
  });
});
