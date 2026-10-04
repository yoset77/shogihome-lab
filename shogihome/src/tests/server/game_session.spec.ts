import { Record, SpecialMoveType, importKIF } from "tsshogi";
import { GameSession } from "@/server/game/session";
import { GameSessionManager } from "@/server/game/manager";
import { decodeGameSnapshot } from "@/common/game/protocol";
import { restoreRecord, MAX_SNAPSHOT_PLY } from "@/common/record/snapshot";
import { fakeGamePlayer, gameRequest, gameCommand } from "./helpers/game";
import { saveBackup, addHistory } from "@/server/file/history";

vi.mock("@/server/file/history", () => ({
  saveBackup: vi.fn().mockResolvedValue(undefined),
  addHistory: vi.fn().mockResolvedValue(undefined),
}));

describe("server game sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function humanGame(ai = false, source = new Record()) {
    const request = gameRequest(source);
    if (ai) request.settings.white = { uri: "lan-engine:test", name: "AI" };
    request.settings.startPosition = "current";
    const fake = fakeGamePlayer();
    const session = new GameSession("session", request, {
      playerBuilder: fake.builder,
      now: () => Date.now(),
    });
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    const send = vi.fn();
    const connection = session.connect("controller", send);
    await session.command(gameCommand(session.snapshot(), "resume"));
    return { session, connection, send, request, ...fake };
  }

  it("owns human moves and applies duplicate commands only once", async () => {
    const { session } = await humanGame();
    const command = gameCommand(session.snapshot(), "move", { move: "7g7f" });
    const [a, b] = await Promise.all([session.command(command), session.command(command)]);
    expect(a.record.currentId).toBe(b.record.currentId);
    expect(restoreRecord(session.snapshot().record).record.current.ply).toBe(1);
    expect(() => session.command({ ...command, move: "2g2f" })).toThrow();
    await expect(session.command(gameCommand(a, "move", { move: "7g7f" }))).rejects.toThrow();
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
  });

  it("pauses exact human time on disconnect and resumes only after a synchronized command", async () => {
    const { session, connection } = await humanGame();
    await vi.advanceTimersByTimeAsync(1250);
    connection.disconnect();
    const paused = session.snapshot();
    expect(paused.state).toBe("paused");
    expect(paused.clocks.black.timeMs).toBe(58_750);
    await vi.advanceTimersByTimeAsync(20_000);
    session.connect("controller", () => {});
    expect(session.snapshot().state).toBe("paused");
    await session.command(gameCommand(session.snapshot(), "resume"));
    expect(session.snapshot().clocks.black.timeMs).toBe(58_750);
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
  });

  it("lets an AI finish while disconnected, then stops on the next human turn", async () => {
    const { session, searches, connection } = await humanGame(true);
    await session.command(gameCommand(session.snapshot(), "move", { move: "7g7f" }));
    connection.disconnect();
    expect(session.snapshot().state).toBe("running");
    await vi.advanceTimersByTimeAsync(1250);
    const position = restoreRecord(session.snapshot().record).record.position;
    searches[0].handler.onMove(position.createMoveByUSI("3c3d")!);
    const paused = session.snapshot();
    expect(paused.state).toBe("paused");
    expect(restoreRecord(paused.record).record.current.ply).toBe(2);
    expect(paused.clocks.white.timeMs).toBe(58_750);
    expect(paused.clocks.black.running).toBe(false);
    session.connect("controller", () => {});
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
  });

  it("detects an inactive application even when the socket transport remains connected", async () => {
    const { session } = await humanGame();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.snapshot().state).toBe("paused");
    expect(session.snapshot().clocks.black.timeMs).toBe(30_000);
    session.connect("controller", () => {});
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
  });

  it("rejects replaced controllers and obsolete human turns", async () => {
    const { session, connection } = await humanGame();
    const old = gameCommand(session.snapshot(), "move", { move: "7g7f" });
    session.connect("controller", () => {});
    connection.disconnect();
    expect(() => session.command(old)).toThrow();
    await session.command(gameCommand(session.snapshot(), "resume"));
    const stale = gameCommand(session.snapshot(), "resign");
    await session.command(gameCommand(session.snapshot(), "move", { move: "7g7f" }));
    await expect(session.command(stale)).rejects.toThrow();
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
  });

  it("fences reconnects without disturbing the replacement controller", async () => {
    const { session, connection } = await humanGame();
    const epoch = session.snapshot().controllerEpoch;
    connection.disconnect();
    const close = vi.fn();
    session.connect("controller", () => {}, close, {
      connectionId: "replacement",
      controllerEpoch: epoch,
    });
    await session.command(gameCommand(session.snapshot(), "resume"));
    const current = session.snapshot();
    expect(() =>
      session.connect(
        "controller",
        () => {},
        () => {},
        {
          connectionId: "old-tab",
          controllerEpoch: epoch,
        },
      ),
    ).toThrow();
    expect(session.snapshot().controllerEpoch).toBe(current.controllerEpoch);
    expect(session.snapshot().state).toBe("running");
    expect(close).not.toHaveBeenCalled();
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
  });

  it("allows the same connection to retry when its initial snapshot was lost", async () => {
    const { session, connection } = await humanGame();
    connection.disconnect();
    const binding = {
      connectionId: "browser",
      controllerEpoch: session.snapshot().controllerEpoch,
    };
    session
      .connect(
        "controller",
        () => {},
        () => {},
        binding,
      )
      .disconnect();
    const send = vi.fn();
    const retry = session.connect("controller", send, () => {}, binding);
    expect(send).toHaveBeenCalledWith({
      type: "snapshot",
      value: expect.objectContaining({
        controllerEpoch: retry.epoch,
        controllerConnectionId: binding.connectionId,
      }),
    });
    expect(() =>
      session.connect(
        "controller",
        () => {},
        () => {},
        {
          ...binding,
          controllerEpoch: retry.epoch + 1,
        },
      ),
    ).toThrow();
    await session.command(gameCommand(session.snapshot(), "resume"));
    expect(session.snapshot().state).toBe("running");
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
  });

  it("settles timeout before accepting a human move", async () => {
    const { session } = await humanGame();
    vi.setSystemTime(Date.now() + 70_001);
    await session.command(gameCommand(session.snapshot(), "move", { move: "7g7f" }));
    await vi.advanceTimersByTimeAsync(0);
    await session.completion;
    const record = restoreRecord(session.snapshot().record).record;
    expect(record.current.move).toEqual({ type: SpecialMoveType.TIMEOUT });
    expect(record.current.prev?.ply).toBe(0);
    await session.close();
  });

  it("settles timeout before interruption and disconnect", async () => {
    for (const action of ["interrupt", "disconnect"] as const) {
      const { session, connection } = await humanGame();
      vi.setSystemTime(Date.now() + 70_001);
      if (action === "interrupt") await session.command(gameCommand(session.snapshot(), action));
      else connection.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      await session.completion;
      expect(restoreRecord(session.snapshot().record).record.current.move).toEqual({
        type: SpecialMoveType.TIMEOUT,
      });
      await session.close();
    }
  });

  it("validates and fences research annotations at the current node and turn", async () => {
    const { session } = await humanGame();
    const snapshot = session.snapshot();
    const annotation = gameCommand(snapshot, "annotate", {
      nodeId: snapshot.record.currentId,
      annotation: { slot: "researchInfo", info: { usi: "position startpos", depth: 8, score: 42 } },
    });
    expect(session.annotate(annotation)).toBe(true);
    expect(session.annotate({ ...annotation, controllerEpoch: snapshot.controllerEpoch - 1 })).toBe(
      false,
    );
    expect(session.annotate({ ...annotation, nodeId: "unknown" })).toBe(false);
    expect(
      session.annotate({
        ...annotation,
        annotation: { slot: "researchInfo", info: { usi: "position startpos moves 7g7f" } },
      }),
    ).toBe(false);
    expect(
      session.annotate({
        ...annotation,
        annotation: {
          slot: "researchInfo",
          info: { usi: "position startpos", depth: 1, score: 1 },
        },
      }),
    ).toBe(true);
    expect(session.snapshot().record.nodes[0].customData?.researchInfo?.score).toBe(42);
    await session.command(gameCommand(session.snapshot(), "move", { move: "7g7f" }));
    expect(session.annotate(annotation)).toBe(false);
    expect(session.snapshot().record.nodes[1].customData?.researchInfo).toBeUndefined();
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
  });

  it("records each mover's elapsed time rather than the opponent's last turn", async () => {
    const { session } = await humanGame();
    await vi.advanceTimersByTimeAsync(1250);
    await session.command(gameCommand(session.snapshot(), "move", { move: "7g7f" }));
    await vi.advanceTimersByTimeAsync(2250);
    await session.command(gameCommand(session.snapshot(), "move", { move: "3c3d" }));
    const record = restoreRecord(session.snapshot().record).record;
    expect(record.moves[1].elapsedMs).toBe(1250);
    expect(record.moves[2].elapsedMs).toBe(2250);
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
  });

  it("does not reuse node IDs after rollback or collide with supplied IDs", async () => {
    const { session, request } = await humanGame(true);
    const initial = session.snapshot().record.currentId;
    await session.command(gameCommand(session.snapshot(), "move", { move: "7g7f" }));
    const removed = session.snapshot().record.currentId;
    await session.command(gameCommand(session.snapshot(), "takeback"));
    expect(session.snapshot().record.currentId).toBe(initial);
    await session.command(gameCommand(session.snapshot(), "move", { move: "7g7f" }));
    expect(session.snapshot().record.currentId).not.toBe(removed);
    expect(decodeGameSnapshot(session.snapshot()).ok).toBe(true);
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
    request.source.nodes[0].id = "g_1";
    request.source.currentId = "g_1";
    request.source.selectedPath = ["g_1"];
    const another = new GameSession("other", request, { playerBuilder: fakeGamePlayer().builder });
    another.start();
    await vi.advanceTimersByTimeAsync(0);
    another.connect("controller", () => {});
    await another.command(gameCommand(another.snapshot(), "resume"));
    await another.command(gameCommand(another.snapshot(), "move", { move: "7g7f" }));
    expect(decodeGameSnapshot(another.snapshot()).ok).toBe(true);
    await another.command(gameCommand(another.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await another.close();
  });

  it("remains interruptible while takeback awaits cancellation", async () => {
    const { session, player, searches } = await humanGame(true);
    await session.command(gameCommand(session.snapshot(), "move", { move: "7g7f" }));
    let finish!: () => void;
    vi.mocked(player.cancelSearch!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = session.command(gameCommand(session.snapshot(), "takeback"));
    await Promise.resolve();
    expect(session.snapshot().state).toBe("takingBack");
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await pending;
    searches[0].handler.onResign();
    expect(session.snapshot().state).toBe("completed");
    expect(restoreRecord(session.snapshot().record).record.current.prev?.ply).toBe(1);
    await session.close();
  });

  async function repeated(repeat = 2, autoSave = true, saveFails = true) {
    const request = gameRequest();
    request.settings.black = { uri: "lan-engine:black", name: "Black" };
    request.settings.white = { uri: "lan-engine:white", name: "White" };
    request.settings.repeat = repeat;
    request.settings.enableAutoSave = autoSave;
    const fake = fakeGamePlayer();
    vi.mocked(fake.player.startSearch).mockImplementation(async (_p, _u, _t, handler) => {
      handler.onResign();
    });
    const saveRecord = vi.fn(async (): Promise<string> => {
      if (saveFails) throw new Error("Disk unavailable");
      return `saved-${vi.mocked(addHistory).mock.calls.length}.kifu`;
    });
    const session = new GameSession("repeated", request, {
      playerBuilder: fake.builder,
      saveRecord,
      now: () => Date.now(),
    });
    session.start();
    await vi.advanceTimersByTimeAsync(repeat + 10);
    await session.completion;
    return { session, saveRecord };
  }

  it("runs repeated AI games without a browser and freezes failed saves before the next game", async () => {
    const { session, saveRecord } = await repeated();
    expect(session.snapshot()).toMatchObject({
      state: "completed",
      error: "save",
      results: { total: 2 },
    });
    expect(saveRecord).toHaveBeenCalledTimes(2);
    expect(saveBackup).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveBackup).mock.calls[0][0]).toContain("1/2");
    expect(vi.mocked(saveBackup).mock.calls[1][0]).toContain("2/2");
    expect(session.snapshot().records.map((record) => record.state)).toEqual(["failed", "failed"]);
    const first = importKIF(vi.mocked(saveBackup).mock.calls[0][0]) as Record;
    first.goto(first.length);
    expect(first.current.move).toEqual({ type: SpecialMoveType.RESIGN });
    expect(addHistory).not.toHaveBeenCalled();
    await session.close();
  });

  it("backs up each game without imposing a separate unsaved retention limit", async () => {
    const { session, saveRecord } = await repeated(101, false);
    expect(session.snapshot()).toMatchObject({
      state: "completed",
      results: { total: 101 },
    });
    expect(session.snapshot().error).toBeUndefined();
    expect(saveBackup).toHaveBeenCalledTimes(101);
    expect(saveRecord).not.toHaveBeenCalled();
    await session.close();
  });

  it("registers automatically saved files in history instead of duplicating backups", async () => {
    const { session } = await repeated(2, true, false);
    expect(addHistory).toHaveBeenNthCalledWith(1, "server://saved-0.kifu");
    expect(addHistory).toHaveBeenNthCalledWith(2, "server://saved-1.kifu");
    expect(saveBackup).not.toHaveBeenCalled();
    expect(session.snapshot().records.map((record) => record.state)).toEqual(["saved", "saved"]);
    await session.close();
  });

  it("reports history failures and continues without a third retention layer", async () => {
    vi.mocked(saveBackup).mockRejectedValueOnce(new Error("History unavailable"));
    const { session } = await repeated(2, false);
    expect(session.snapshot()).toMatchObject({
      state: "completed",
      error: "save",
      results: { total: 2 },
    });
    expect(saveBackup).toHaveBeenCalledTimes(2);
    expect(session.snapshot().records.map((record) => record.state)).toEqual(["failed", "unsaved"]);
    await session.close();
  });

  it("does not recreate a saved file when its history registration fails", async () => {
    vi.mocked(addHistory).mockRejectedValueOnce(new Error("History unavailable"));
    const { session, saveRecord } = await repeated(2, true, false);
    expect(saveRecord).toHaveBeenCalledTimes(2);
    expect(addHistory).toHaveBeenCalledTimes(2);
    expect(saveBackup).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({
      state: "completed",
      error: "save",
      results: { total: 2 },
    });
    await session.close();
  });

  it("deduplicates creation, freezes settings and never recreates expired sessions", async () => {
    const manager = new GameSessionManager({ now: () => Date.now() });
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    const session = manager.create(request);
    expect(manager.create(request)).toBe(session);
    expect(() =>
      manager.create({ ...request, settings: { ...request.settings, maxMoves: 200 } }),
    ).toThrow();
    request.settings.timeLimit.timeSeconds = 500;
    expect(session.request.settings.timeLimit.timeSeconds).toBe(60);
    await vi.advanceTimersByTimeAsync(0);
    session.connect("controller", () => {});
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(0);
    await session.completion;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(() => manager.byRequest(request.requestId)).toThrow();
    expect(() => manager.create({ ...request, settings: session.request.settings })).toThrow();
    await manager.close();
  });

  it("closes both players when repeated-game preparation fails", async () => {
    const request = gameRequest();
    request.settings.black = { uri: "lan-engine:black", name: "Black" };
    request.settings.white = { uri: "lan-engine:white", name: "White" };
    request.settings.repeat = 2;
    const fake = fakeGamePlayer();
    vi.mocked(fake.player.startSearch).mockImplementation(async (_p, _u, _t, handler) =>
      handler.onResign(),
    );
    vi.mocked(fake.player.readyNewGame)
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("Connection closed"));
    const session = new GameSession("failure", request, { playerBuilder: fake.builder });
    session.start();
    await vi.advanceTimersByTimeAsync(10);
    await session.completion;
    expect(session.snapshot().state).toBe("failed");
    expect(fake.player.close).toHaveBeenCalledTimes(2);
    expect(saveBackup).toHaveBeenCalledOnce();
    await session.close();
  });

  it("can interrupt before the initial turn timer starts", async () => {
    const request = gameRequest();
    const session = new GameSession("startup", request);
    session.start();
    session.connect("controller", () => {});
    await session.command(gameCommand(session.snapshot(), "interrupt"));
    await vi.advanceTimersByTimeAsync(10);
    await session.completion;
    expect(session.snapshot().state).toBe("completed");
    expect(session.snapshot().clocks.black.running).toBe(false);
    await session.close();
  });

  it("rejects an oversized position-list entry before replacing the original document", async () => {
    const request = gameRequest();
    request.settings.startPosition = "list";
    const original = request.source;
    const session = new GameSession("large-list", request, {
      loadPositions: async () => [
        "position startpos moves " + "5i5h 5a5b 5h5i 5b5a ".repeat(MAX_SNAPSHOT_PLY / 4 + 1).trim(),
      ],
    });
    session.start();
    await vi.advanceTimersByTimeAsync(10);
    await session.completion;
    expect(session.snapshot().state).toBe("failed");
    expect(session.snapshot().record).toEqual(original);
    await session.close();
  });
});
