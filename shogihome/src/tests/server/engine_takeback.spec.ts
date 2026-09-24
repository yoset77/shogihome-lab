import { PassThrough } from "stream";
import { EngineSession } from "@/server/engine/session";
import { EngineState } from "@/server/engine/types";
import {
  decodeServerRelayMessage,
  type ClientRelayMessage,
  type SearchSnapshot,
} from "@/common/engine/relay_protocol";

vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));

function setup() {
  const ws = { send: vi.fn(), terminate: vi.fn(), on: vi.fn(), readyState: 1 };
  const engine = { write: vi.fn(), close: vi.fn(), removeAllListeners: vi.fn() };
  const session = new EngineSession("takeback");
  const internal = session as unknown as {
    engineState: EngineState;
    currentEngineId: string;
    engineHandle: typeof engine;
    handleMessage(message: ClientRelayMessage): void;
    setupEngineHandlers(stream: PassThrough): void;
    handleDisconnect(ws: unknown): void;
  };
  internal.engineState = EngineState.READY;
  internal.currentEngineId = "test";
  internal.engineHandle = engine;
  const stream = new PassThrough();
  internal.setupEngineHandlers(stream);
  session.attach(ws as unknown as Parameters<EngineSession["attach"]>[0]);
  const snapshot = () =>
    ws.send.mock.calls
      .map(([data]) => decodeServerRelayMessage(data))
      .filter((r) => r.ok && r.value.type === "searchSnapshot")
      .at(-1) as { ok: true; value: SearchSnapshot };
  const instanceId = snapshot().value.instanceId;
  const search = (id: number) =>
    internal.handleMessage({
      type: "search",
      instanceId,
      searchId: id,
      position: "position startpos",
      go: "go infinite",
    });
  const cancel = (through: number) =>
    internal.handleMessage({ type: "cancelSearch", instanceId, through });
  return { ws, engine, session, internal, stream, snapshot, instanceId, search, cancel };
}

describe("engine cancellation barrier", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("waits for terminal output and never restarts a cancelled search", () => {
    const { search, cancel, snapshot, stream, engine } = setup();
    search(1);
    cancel(1);
    expect(snapshot().value.settled).toBe(0);
    stream.write("bestmove 7g7f\n");
    expect(snapshot().value.settled).toBe(1);
    search(1);
    expect(engine.write.mock.calls.filter(([line]) => line === "go infinite\n")).toHaveLength(1);
    search(2);
    cancel(1);
    expect(engine.write.mock.calls.filter(([line]) => line === "stop\n")).toHaveLength(1);
  });

  it("cancels a request that has not arrived yet", () => {
    const { cancel, search, engine, snapshot } = setup();
    cancel(3);
    search(3);
    expect(engine.write).not.toHaveBeenCalled();
    expect(snapshot().value.settled).toBe(3);
  });

  it("replays completion even when the original notification was sent on an open socket", () => {
    const { search, stream, session, ws, snapshot } = setup();
    search(1);
    stream.write("bestmove 7g7f\n");
    ws.send.mockClear();
    session.attach(ws as unknown as Parameters<EngineSession["attach"]>[0]);
    expect(snapshot().value.terminal?.searchId).toBe(1);
  });

  it("does not extend the engine stop deadline when the browser disconnects", async () => {
    const { search, cancel, internal, ws, engine } = setup();
    search(1);
    cancel(1);
    internal.handleDisconnect(ws);
    await vi.advanceTimersByTimeAsync(10001);
    expect(engine.close).toHaveBeenCalledOnce();
  });
});
