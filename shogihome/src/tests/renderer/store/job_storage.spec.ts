import { JobStorage, isReloadNavigation } from "@/renderer/store/job_storage";

describe("job storage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  const decode = (raw: string | null) => (raw ? JSON.parse(raw) : undefined);
  const reference = { requestId: "request", serverInstanceId: "server", jobId: "job" };

  it("never uses a durable journal or a legacy reference as attachment intent", () => {
    localStorage.setItem("legacy:request", JSON.stringify(reference));
    const storage = new JobStorage("analysis", "legacy", decode);
    storage.migrate();
    expect(storage.load()).toBeUndefined();
    expect(localStorage.getItem("legacy:request")).toBeNull();
    expect(storage.journal()).toEqual([reference]);
  });

  it("detaches without discarding unconfirmed operations", () => {
    const storage = new JobStorage("analysis", "legacy", decode);
    storage.save(reference);
    storage.writeJournal(reference);
    storage.detach(reference);
    expect(storage.load()).toBeUndefined();
    expect(storage.journal()).toEqual([reference]);
  });

  it("does not erase another attachment when an older operation finishes", () => {
    const storage = new JobStorage("analysis", "legacy", decode);
    const other = { ...reference, requestId: "other" };
    storage.save(other);
    storage.detach(reference);
    expect(storage.load()).toEqual(other);
  });

  it("does not erase a newer generation belonging to the same recovery owner", () => {
    const storage = new JobStorage("game", "legacy", decode);
    storage.save({ ...reference, controllerId: "owner", controllerEpoch: 2 });
    storage.detach({ ...reference, controllerId: "owner", controllerEpoch: 1 });
    expect(storage.load()?.controllerEpoch).toBe(2);
  });

  it("does not treat navigation into a copied tab session as a reload", () => {
    const getEntries = vi.fn(() => [{ type: "navigate" }]);
    vi.stubGlobal("performance", { getEntriesByType: getEntries });
    try {
      expect(isReloadNavigation()).toBe(false);
      getEntries.mockReturnValue([{ type: "reload" }]);
      expect(isReloadNavigation()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves legacy linkage intact when durable migration cannot be written", () => {
    const storage = new JobStorage("analysis", "legacy", decode);
    localStorage.setItem("legacy:request", JSON.stringify(reference));
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    try {
      expect(() => storage.migrate()).toThrow("Storage unavailable");
      expect(localStorage.getItem("legacy:request")).not.toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("keeps each unresolved operation in an independent journal entry", () => {
    const storage = new JobStorage(
      "game",
      "legacy",
      decode,
      (ref) => ref,
      (ref) =>
        ref.operations.map((operation: string) => ({
          id: operation,
          reference: { ...ref, operations: [operation] },
        })),
    );
    storage.writeJournal({ ...reference, operations: ["first", "second"] });
    storage.forgetOperation(reference, "first");
    expect(storage.journal()).toEqual([{ ...reference, operations: ["second"] }]);
  });
});
