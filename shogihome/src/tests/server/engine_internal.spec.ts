import { PassThrough } from "node:stream";
import { EngineSession } from "@/server/engine/session";
import { EngineState } from "@/server/engine/types";
import { InternalEngine } from "@/server/engine/internal";

vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));

function setup() {
  const session = new EngineSession("internal-test", undefined, "internal");
  const engine = { write: vi.fn(), close: vi.fn(), destroy: vi.fn(), removeAllListeners: vi.fn() };
  const internal = session as unknown as {
    engineState: EngineState;
    engineHandle: typeof engine;
    setupEngineHandlers(stream: PassThrough): void;
    onEngineClose(): void;
    messageBuffer: unknown[];
  };
  internal.engineState = EngineState.READY;
  internal.engineHandle = engine;
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
