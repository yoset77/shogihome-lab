import { GameRecoveryStorage } from "@/renderer/store/game_recovery";

describe("durable human game recovery candidates", () => {
  const storage = new GameRecoveryStorage();
  const reference = {
    requestId: "request",
    serverInstanceId: "server",
    controllerId: "owner",
    sessionId: "session",
    recoveryId: "recovery",
    connectionId: "connection",
    controllerEpoch: 2,
    controllerGeneration: 0,
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("survives loss of tab storage without storing records or unconfirmed commands", () => {
    const source = { ...reference, content: "record", pending: [{ action: "move" }] };
    storage.save(source);
    sessionStorage.clear();
    expect(storage.list()).toEqual([reference]);
    const raw = JSON.parse(localStorage.getItem(Object.keys(localStorage)[0])!);
    expect(raw.content).toBeUndefined();
    expect(raw.pending).toBeUndefined();
  });

  it("keeps different requests and owners independent", () => {
    const other = { ...reference, requestId: "other" };
    storage.save(reference);
    storage.save(other);
    storage.save({ ...reference, controllerId: "another-owner" });
    storage.forget(reference);
    expect(storage.list()).toEqual([other, { ...reference, controllerId: "another-owner" }]);
  });

  it("does not overwrite or remove a newer connection from an old screen", () => {
    storage.save(reference);
    storage.save({ ...reference, controllerEpoch: 3 });
    storage.save(reference);
    storage.forget(reference);
    expect(storage.get(reference)?.controllerEpoch).toBe(3);
  });

  it("compares ownership generations before connection epochs", () => {
    const next = { ...reference, controllerGeneration: 1, controllerEpoch: 1 };
    storage.save(next);
    storage.save(reference);
    storage.forget(reference);
    expect(storage.get(reference)).toEqual(next);
  });

  it("ignores malformed candidates and unrelated browser storage", () => {
    localStorage.setItem("shogihome-game-recovery:invalid", "{");
    localStorage.setItem("shogihome-game-recovery:version", JSON.stringify({ version: 2 }));
    localStorage.setItem("shogihome-game-recovery:missing", JSON.stringify({ version: 1 }));
    localStorage.setItem("shogihome-job-journal:game:request", JSON.stringify(reference));
    expect(storage.list()).toEqual([]);
    expect(localStorage).toHaveLength(4);
  });

  it("leaves the previous candidate intact when an update cannot be stored", () => {
    storage.save(reference);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    try {
      expect(() => storage.save({ ...reference, controllerEpoch: 3 })).toThrow("Storage full");
      expect(storage.get(reference)).toEqual(reference);
    } finally {
      write.mockRestore();
    }
  });
});
