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
    const result = expect(close).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_001);
    await result;
    expect(engine.destroy).toHaveBeenCalledOnce();
  });
});
