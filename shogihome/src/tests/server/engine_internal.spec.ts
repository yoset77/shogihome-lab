import { PassThrough } from "node:stream";
import { EngineSession } from "@/server/engine/session";
import { EngineState } from "@/server/engine/types";
import { InternalEngine } from "@/server/engine/internal";

vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));

function setup() {
  const session = new EngineSession("internal-test", undefined, "internal");
  const engine = { write: vi.fn(), close: vi.fn(), destroy: vi.fn() };
  const internal = session as unknown as {
    engineState: EngineState;
    engineRun: { handle: typeof engine };
    currentEngineId: string;
    setupEngineHandlers(stream: PassThrough): void;
    onEngineClose(): void;
    messageBuffer: unknown[];
  };
  internal.engineState = EngineState.READY;
  internal.engineRun.handle = engine;
  internal.currentEngineId = "test";
  const stream = new PassThrough();
  internal.setupEngineHandlers(stream);
  return { session, engine, internal, stream };
}

describe("server-owned engine sessions", () => {
  afterEach(() => vi.useRealTimers());

  it("searches and settles without a WebSocket and does not buffer relay frames", async () => {
    const { session, stream, engine, internal } = setup();
    const instanceId = session.internalSnapshot.instanceId;
    session.dispatchInternal({
      type: "search",
      instanceId,
      searchId: 1,
      position: "position startpos",
      go: "go infinite",
    });
    expect(engine.write).toHaveBeenCalledWith("go infinite\n");
    session.dispatchInternal({ type: "stopSearch", instanceId, searchId: 1 });
    const observed: EngineState[] = [];
    session.subscribeInternal((event) => {
      if (event.type === "engineOutput" && event.output.startsWith("bestmove"))
        observed.push(session.internalSnapshot.state);
    });
    stream.write("bestmove 7g7f\n");
    await Promise.resolve();
    expect(observed).toEqual([EngineState.READY]);
    expect(session.internalSnapshot.terminal?.searchId).toBe(1);
    expect(internal.messageBuffer).toEqual([]);
    session.destroyInternal();
  });

  it("rejects relay attachment and cross-owner commands", () => {
    const { session } = setup();
    expect(() => session.attach({} as never)).toThrow("owned by server");
    expect(() => new EngineSession("relay").dispatchInternal({ type: "ping" })).toThrow(
      "owned by relay",
    );
    session.destroyInternal();
  });

  it("uses startup readiness for the first game and waits for readyok before each later game", async () => {
    const { session, stream, engine, internal } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    const signal = new AbortController().signal;
    try {
      internal.engineState = EngineState.WAITING_USIOK;
      stream.write("usiok\nreadyok\n");
      await client.readyNewGame(signal);
      expect(engine.write.mock.calls.map(([line]) => line)).toEqual(["isready\n", "usinewgame\n"]);
      client.gameover("win");
      const ready = client.readyNewGame(signal);
      const resolved = vi.fn();
      void ready.then(resolved, () => {});
      expect(session.internalSnapshot.state).toBe(EngineState.WAITING_READYOK);
      expect(engine.write).toHaveBeenLastCalledWith("isready\n");
      stream.write("bestmove 7g7f\n");
      await Promise.resolve();
      expect(resolved).not.toHaveBeenCalled();
      expect(session.internalSnapshot.state).toBe(EngineState.WAITING_READYOK);
      stream.write("readyok\n");
      await ready;
      expect(engine.write.mock.calls.map(([line]) => line)).toEqual([
        "isready\n",
        "usinewgame\n",
        "gameover win\n",
        "isready\n",
        "usinewgame\n",
      ]);
    } finally {
      session.destroyInternal();
    }
  });

  it("preserves gameover after stop and gates queued lifecycle commands and searches on readyok", () => {
    const { session, stream, engine, internal } = setup();
    const instanceId = session.internalSnapshot.instanceId;
    internal.engineState = EngineState.WAITING_USIOK;
    stream.write("usiok\nreadyok\n");
    session.dispatchInternal({ type: "usi", command: "usinewgame" });
    session.dispatchInternal({
      type: "search",
      instanceId,
      searchId: 1,
      position: "position startpos",
      go: "go infinite",
    });
    engine.write.mockClear();
    session.dispatchInternal({ type: "usi", command: "gameover draw" });
    session.dispatchInternal({ type: "usi", command: "usinewgame" });
    session.dispatchInternal({ type: "usi", command: "setoption name MultiPV value 2" });
    session.dispatchInternal({
      type: "search",
      instanceId,
      searchId: 2,
      position: "position startpos moves 7g7f",
      go: "go btime 60000 wtime 60000 byoyomi 0",
    });
    expect(engine.write).toHaveBeenCalledExactlyOnceWith("stop\n");
    stream.write("bestmove 7g7f\n");
    expect(engine.write.mock.calls.map(([line]) => line)).toEqual([
      "stop\n",
      "gameover draw\n",
      "isready\n",
    ]);
    expect(session.internalSnapshot.active).toBeNull();
    stream.write("readyok\n");
    expect(engine.write.mock.calls.map(([line]) => line)).toEqual([
      "stop\n",
      "gameover draw\n",
      "isready\n",
      "usinewgame\n",
      "setoption name MultiPV value 2\n",
      "position startpos moves 7g7f\n",
      "go btime 60000 wtime 60000 byoyomi 0\n",
    ]);
    expect(session.internalSnapshot.active).toBe(2);
    session.destroyInternal();
  });

  it("preserves MultiPV set before a new game while an internal search is still stopping", async () => {
    const { session, stream, engine, internal } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    const signal = new AbortController().signal;
    try {
      internal.engineState = EngineState.WAITING_USIOK;
      stream.write("usiok\nreadyok\n");
      await client.readyNewGame(signal);
      const search = await client.startResearch("position startpos", () => {}, signal);
      engine.write.mockClear();
      client.setMultiPV(3);
      const ready = client.readyNewGame(signal);
      expect(engine.write).toHaveBeenCalledExactlyOnceWith("stop\n");
      stream.write("bestmove 7g7f\n");
      await search.finished;
      expect(session.internalSnapshot.state).toBe(EngineState.WAITING_READYOK);
      expect(engine.write.mock.calls.map(([command]) => command)).toEqual(["stop\n", "isready\n"]);
      stream.write("readyok\n");
      await ready;
      expect(engine.write.mock.calls.map(([command]) => command)).toEqual([
        "stop\n",
        "isready\n",
        "usinewgame\n",
        "setoption name MultiPV value 3\n",
      ]);
      expect(session.internalSnapshot.state).toBe(EngineState.READY);
    } finally {
      session.destroyInternal();
    }
  });

  it("bounds readiness waiting when the engine never returns readyok", async () => {
    vi.useFakeTimers();
    const { session, engine } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    try {
      const ready = expect(client.readyNewGame(new AbortController().signal)).rejects.toThrow(
        "timed out",
      );
      expect(engine.write).toHaveBeenCalledExactlyOnceWith("isready\n");
      await vi.advanceTimersByTimeAsync(10_001);
      await ready;
      expect(engine.write).not.toHaveBeenCalledWith("usinewgame\n");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      session.destroyInternal();
    }
  });

  it.each([1, 60])(
    "preserves the configured %s-second internal readiness timeout",
    async (timeout) => {
      vi.useFakeTimers();
      const { session, engine } = setup();
      const client = new InternalEngine();
      (client as unknown as { session: EngineSession }).session = session;
      const start = vi.spyOn(session, "startInternalEngine").mockImplementation(() => {});
      const signal = new AbortController().signal;
      try {
        await client.launch({ id: "test", name: "Test" }, timeout, signal);
        const ready = expect(client.readyNewGame(signal)).rejects.toThrow("timed out");
        await vi.advanceTimersByTimeAsync(timeout * 1000 - 1);
        expect(session.internalSnapshot.state).toBe(EngineState.WAITING_READYOK);
        expect(vi.getTimerCount()).toBe(1);
        expect(engine.close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await ready;
        expect(engine.write).toHaveBeenCalledExactlyOnceWith("isready\n");
        expect(engine.close).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        session.destroyInternal();
        start.mockRestore();
      }
    },
  );

  it("rejects pending readiness on close and never starts a game from a late readyok", async () => {
    const { session, stream, engine, internal } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    const ready = expect(client.readyNewGame(new AbortController().signal)).rejects.toThrow(
      "closed unexpectedly",
    );
    const close = client.close();
    internal.onEngineClose();
    await Promise.all([ready, close]);
    stream.write("readyok\n");
    expect(engine.write).not.toHaveBeenCalledWith("usinewgame\n");
  });

  it("cancels readiness with the current operation's signal when reusing an engine", async () => {
    const { session, engine } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    const controller = new AbortController();
    try {
      const ready = expect(client.readyNewGame(controller.signal)).rejects.toThrow("cancelled");
      expect(engine.write).toHaveBeenCalledExactlyOnceWith("isready\n");
      controller.abort();
      await ready;
      expect(engine.write).not.toHaveBeenCalledWith("usinewgame\n");
    } finally {
      session.destroyInternal();
    }
  });

  it("uses the explicit readiness signal after the launch signal has been aborted", async () => {
    const { session, stream, engine } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    const start = vi.spyOn(session, "startInternalEngine").mockImplementation(() => {});
    const launchController = new AbortController();
    const operationController = new AbortController();
    try {
      await client.launch({ id: "test", name: "Test" }, 10, launchController.signal);
      launchController.abort();
      const ready = client.readyNewGame(operationController.signal);
      stream.write("readyok\n");
      await ready;
      expect(engine.write.mock.calls.map(([command]) => command)).toEqual([
        "isready\n",
        "usinewgame\n",
      ]);
      engine.write.mockClear();
      operationController.abort();
      await expect(client.readyNewGame(operationController.signal)).rejects.toThrow("cancelled");
      expect(engine.write).not.toHaveBeenCalled();
    } finally {
      session.destroyInternal();
      start.mockRestore();
    }
  });

  it("isolates listener exceptions and delivers the same event to later listeners", () => {
    const tasks: (() => void)[] = [];
    const microtask = vi
      .spyOn(globalThis, "queueMicrotask")
      .mockImplementation((task) => tasks.push(task));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { session } = setup();
    const failure = new Error("Listener failed");
    session.subscribeInternal(() => {
      throw failure;
    });
    const later = vi.fn();
    session.subscribeInternal(later);
    session.dispatchInternal({ type: "ping" });
    try {
      expect(() => tasks.shift()!()).not.toThrow();
      expect(later).toHaveBeenCalledWith({ type: "notice", notice: "pong" });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("internal-test"), failure);
    } finally {
      session.destroyInternal();
      microtask.mockRestore();
      log.mockRestore();
    }
  });

  it("keeps terminal waits working when an output listener fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { session, stream } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    try {
      const search = await client.startResearch(
        "position startpos",
        () => {
          throw new Error("Output failed");
        },
        new AbortController().signal,
      );
      stream.write("bestmove 7g7f\n");
      await search.finished;
      expect(log).toHaveBeenCalledWith(
        "Internal engine listener failed (internal-test)",
        expect.objectContaining({ message: "Output failed" }),
      );
    } finally {
      session.destroyInternal();
      log.mockRestore();
    }
  });

  it("snapshots listeners for each delivery when a listener unsubscribes another", async () => {
    const { session } = setup();
    const observed: string[] = [];
    let unsubscribe = () => {};
    session.subscribeInternal(() => {
      observed.push("first");
      unsubscribe();
    });
    unsubscribe = session.subscribeInternal(() => observed.push("second"));
    session.dispatchInternal({ type: "ping" });
    await Promise.resolve();
    session.dispatchInternal({ type: "ping" });
    await Promise.resolve();
    expect(observed).toEqual(["first", "second", "first"]);
    session.destroyInternal();
  });

  it("keeps the stop deadline active without a browser", async () => {
    vi.useFakeTimers();
    const { session, engine } = setup();
    const instanceId = session.internalSnapshot.instanceId;
    session.dispatchInternal({
      type: "search",
      instanceId,
      searchId: 1,
      position: "position startpos",
      go: "go infinite",
    });
    session.dispatchInternal({ type: "cancelSearch", instanceId, through: 1 });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(engine.close).toHaveBeenCalledOnce();
    session.destroyInternal();
  });

  it("bounds close waiting and forcefully releases the transport", async () => {
    vi.useFakeTimers();
    const { session, engine } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    const close = client.close();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(close).resolves.toBeUndefined();
    expect(engine.destroy).toHaveBeenCalledOnce();
  });

  it("allows search stopping and transport shutdown to use separate deadlines", async () => {
    vi.useFakeTimers();
    const { session, engine, internal } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    internal.engineState = EngineState.THINKING;

    const close = client.close();
    expect(engine.write).toHaveBeenCalledExactlyOnceWith("stop\n");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(engine.close).toHaveBeenCalledOnce();
    expect(engine.destroy).not.toHaveBeenCalled();
    expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(close).resolves.toBeUndefined();
    expect(engine.destroy).toHaveBeenCalledOnce();
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for transport closure after a late successful search stop", async () => {
    vi.useFakeTimers();
    const { session, stream, engine, internal } = setup();
    const client = new InternalEngine();
    (client as unknown as { session: EngineSession }).session = session;
    internal.engineState = EngineState.THINKING;

    const closed = vi.fn();
    const close = client.close().then(closed);
    await vi.advanceTimersByTimeAsync(9000);
    stream.write("bestmove 7g7f\n");
    await vi.advanceTimersByTimeAsync(9000);
    expect(engine.close).toHaveBeenCalledOnce();
    expect(engine.destroy).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();

    internal.onEngineClose();
    await close;
    expect(closed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
