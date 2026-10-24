// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { EngineSession } from "@/server/engine/session";
import { EngineState, type EngineConfig } from "@/server/engine/types";
import { resourceRegistry, type ResourceLease } from "@/server/engine/resources";
import {
  ANALYSIS_DB_MIN_DEPTH,
  CONNECTION_PROTECTION_TIMEOUT,
  ENGINE_STOP_TIMEOUT_MS,
} from "@/server/config";
import { saveAnalysisResults } from "@/server/database/sqlite";
import { decodeServerRelayMessage, encodeClientRelayMessage } from "@/common/engine/relay_protocol";
import { getNormalizedSfenAndHash } from "@/server/usi/sfen";

vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  });
}

function setup(identified = false, config: Partial<EngineConfig> = {}) {
  const remove = vi.fn();
  const session = new EngineSession("shutdown", remove);
  const ws = socket();
  const engine = { write: vi.fn(), close: vi.fn(), destroy: vi.fn(), removeAllListeners: vi.fn() };
  const internal = session as unknown as {
    engineState: EngineState;
    currentEngineId: string;
    currentEngineConfig: EngineConfig;
    engineHandle: typeof engine;
    lastInfos: Map<number, unknown>;
    resourceLease?: ResourceLease;
    setupEngineHandlers(stream: PassThrough): void;
    onEngineClose(): void;
  };
  internal.engineState = EngineState.READY;
  internal.currentEngineId = "test";
  internal.currentEngineConfig = { id: "test", name: "Test", ...config };
  internal.engineHandle = engine;
  const output = new PassThrough();
  internal.setupEngineHandlers(output);
  session.attach(ws as unknown as WebSocket);
  const search = (id = 1) => {
    const position = id === 1 ? "position startpos" : "position startpos moves 7g7f";
    if (identified) {
      ws.emit(
        "message",
        encodeClientRelayMessage({
          type: "search",
          instanceId: session.internalSnapshot.instanceId,
          searchId: id,
          position,
          go: "go infinite",
        }),
      );
    } else {
      ws.emit("message", position);
      ws.emit("message", "go infinite");
    }
  };
  const disconnect = () => {
    ws.readyState = WebSocket.CLOSED;
    ws.emit("close");
  };
  return { session, ws, engine, internal, output, remove, search, disconnect };
}

describe("engine shutdown persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(saveAnalysisResults).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resourceRegistry.resetForTest();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe.each([false, true])("identified search: %s", (identified) => {
    it.each(["stop_engine", "quit", "protection timeout"])(
      "saves final output before closing on %s, even without a browser",
      (reason) => {
        const { session, ws, engine, internal, output, remove, search, disconnect } =
          setup(identified);
        search();
        output.write("info depth 100 nodes 123 score cp 10 pv 7g7f\n");
        if (reason === "protection timeout") {
          disconnect();
          vi.advanceTimersByTime(CONNECTION_PROTECTION_TIMEOUT - 1);
          expect(engine.write).not.toHaveBeenCalledWith("stop\n");
          vi.advanceTimersByTime(1);
        } else {
          ws.emit("message", reason);
          disconnect();
        }
        expect(session.internalSnapshot.state).toBe(EngineState.STOPPING_ENGINE);
        expect(engine.write.mock.calls.map(([command]) => command)).toEqual([
          "position startpos\n",
          "go infinite\n",
          "stop\n",
        ]);
        expect(engine.close).not.toHaveBeenCalled();
        expect(engine.destroy).not.toHaveBeenCalled();
        expect(saveAnalysisResults).not.toHaveBeenCalled();

        output.write("info depth 101 score cp 20 pv 7g7f 3c3d\n");
        output.write("bestmove 7g7f\n");
        const position = getNormalizedSfenAndHash("position startpos")!;
        expect(saveAnalysisResults).toHaveBeenCalledExactlyOnceWith(
          position.hash,
          position.sfen,
          "test",
          "Test",
          new Map([[1, expect.objectContaining({ depth: 101, nodes: 123, scoreCP: 20 })]]),
        );
        expect(engine.close).toHaveBeenCalledOnce();
        expect(vi.mocked(saveAnalysisResults).mock.invocationCallOrder[0]).toBeLessThan(
          engine.close.mock.invocationCallOrder[0],
        );
        expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);
        internal.onEngineClose();
        expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
        expect(remove).toHaveBeenCalledExactlyOnceWith("shutdown");
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it.each(["stop_engine", "protection timeout"])(
      "continues %s shutdown immediately when persistence throws",
      (reason) => {
        const { session, ws, engine, internal, output, search, disconnect } = setup(identified);
        const error = new Error("Unexpected persistence failure");
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.mocked(saveAnalysisResults).mockImplementationOnce(() => {
          throw error;
        });
        resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 4 }]);
        internal.resourceLease = resourceRegistry.acquire({ groupId: "g", cost: 4 });
        search();
        output.write("info depth 100 score cp 20 pv 7g7f\n");
        if (reason === "stop_engine") ws.emit("message", "stop_engine");
        disconnect();
        if (reason === "protection timeout") vi.advanceTimersByTime(CONNECTION_PROTECTION_TIMEOUT);

        expect(() => output.write("bestmove 7g7f\n")).not.toThrow();
        expect(saveAnalysisResults).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledExactlyOnceWith("Failed to persist analysis (shutdown)", error);
        expect(internal.lastInfos.size).toBe(0);
        expect(engine.close).toHaveBeenCalledOnce();
        expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);
        expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);

        internal.onEngineClose();
        expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
        expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(ENGINE_STOP_TIMEOUT_MS);
        expect(engine.close).toHaveBeenCalledOnce();
        expect(engine.destroy).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])("finishes a search despite persistence errors (stop: %s)", (stop) => {
      const { session, ws, engine, internal, output, search } = setup(identified);
      const error = new Error("Unexpected persistence failure");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(saveAnalysisResults).mockImplementationOnce(() => {
        throw error;
      });
      search();
      output.write("info depth 100 score cp 20 pv 7g7f\n");
      if (stop) ws.emit("message", "stop");
      ws.send.mockClear();

      expect(() => output.write("bestmove 7g7f\n")).not.toThrow();
      expect(saveAnalysisResults).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledExactlyOnceWith("Failed to persist analysis (shutdown)", error);
      expect(internal.lastInfos.size).toBe(0);
      expect(session.internalSnapshot.state).toBe(EngineState.READY);
      expect(session.internalSnapshot.active).toBeNull();
      if (identified) {
        expect(session.internalSnapshot.terminal).toMatchObject({
          searchId: 1,
          position: "position startpos",
          output: "bestmove 7g7f",
        });
      }
      const messages = ws.send.mock.calls.map(([frame]) => decodeServerRelayMessage(frame));
      expect(messages).toContainEqual({
        ok: true,
        value: expect.objectContaining({ type: "engineOutput", output: "bestmove 7g7f" }),
      });
      expect(messages).toContainEqual({
        ok: true,
        value: expect.objectContaining({ type: "state", state: "ready" }),
      });
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(ENGINE_STOP_TIMEOUT_MS);
      expect(engine.close).not.toHaveBeenCalled();
    });

    it("inherits a pending stop deadline without resending stop or reviving on attach", () => {
      const { session, ws, engine, output, remove, search, disconnect } = setup(identified);
      search();
      ws.emit("message", "stop");
      vi.advanceTimersByTime(4000);
      ws.emit("message", "stop_engine");
      ws.emit("message", "stop_engine");
      disconnect();
      const replacement = socket();
      session.attach(replacement as unknown as WebSocket);
      expect(replacement.close).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(ENGINE_STOP_TIMEOUT_MS - 4001);
      expect(engine.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(engine.close).toHaveBeenCalledOnce();
      expect(engine.write.mock.calls.filter(([command]) => command === "stop\n")).toHaveLength(1);
      expect(remove).toHaveBeenCalledOnce();
      output.write("info depth 100 score cp 20 pv 7g7f\nbestmove 7g7f\n");
      expect(saveAnalysisResults).not.toHaveBeenCalled();
      expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);
    });

    it("discards queued searches and never publishes a ready state or terminal result", () => {
      const { session, ws, engine, output, search } = setup(identified);
      search();
      search(2);
      ws.emit("message", "stop_engine");
      ws.send.mockClear();
      ws.emit("message", "go infinite");
      ws.emit("message", "start_engine test");
      output.write("info depth 100 score cp 20 pv 7g7f\nbestmove 7g7f\n");
      expect(engine.write.mock.calls.map(([command]) => command)).toEqual([
        "position startpos\n",
        "go infinite\n",
        "stop\n",
      ]);
      expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);
      expect(ws.send).not.toHaveBeenCalled();
      output.write("bestmove 7g7f\n");
      expect(saveAnalysisResults).toHaveBeenCalledOnce();
      expect(engine.close).toHaveBeenCalledOnce();
    });
  });

  it("bounds both shutdown phases and holds the resource lease until transport destruction", () => {
    const { session, ws, engine, internal, output, search, disconnect } = setup();
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 4 }]);
    internal.resourceLease = resourceRegistry.acquire({ groupId: "g", cost: 4 });
    search();
    output.write("info depth 100 score cp 20 pv 7g7f\n");
    ws.emit("message", "stop_engine");
    disconnect();
    vi.advanceTimersByTime(ENGINE_STOP_TIMEOUT_MS);
    expect(engine.close).toHaveBeenCalledOnce();
    expect(engine.destroy).not.toHaveBeenCalled();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    vi.advanceTimersByTime(ENGINE_STOP_TIMEOUT_MS - 1);
    expect(engine.destroy).not.toHaveBeenCalled();
    engine.destroy.mockImplementation(() => {
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    });
    vi.advanceTimersByTime(1);
    expect(engine.destroy).toHaveBeenCalledOnce();
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(saveAnalysisResults).not.toHaveBeenCalled();
    output.write("bestmove 7g7f\n");
    internal.onEngineClose();
    expect(saveAnalysisResults).not.toHaveBeenCalled();
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([EngineState.READY, EngineState.WAITING_USIOK, EngineState.WAITING_READYOK])(
    "closes without waiting for a search in state %s",
    (state) => {
      const { session, ws, engine, internal } = setup();
      internal.engineState = state;
      ws.emit("message", "stop_engine");
      expect(engine.write).not.toHaveBeenCalled();
      expect(engine.close).toHaveBeenCalledOnce();
      expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);
      internal.onEngineClose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { config: { skipAnalysisDB: true }, info: "info depth 100 score cp 20 pv 7g7f\n" },
    { config: {}, info: `info depth ${ANALYSIS_DB_MIN_DEPTH - 1} score cp 20 pv 7g7f\n` },
    { config: {}, info: "" },
  ])("preserves persistence exclusions: %j", ({ config, info }) => {
    const { ws, engine, output, search } = setup(false, config);
    search();
    output.write(info);
    ws.emit("message", "stop_engine");
    output.write("bestmove 7g7f\n");
    expect(engine.close).toHaveBeenCalledOnce();
    expect(saveAnalysisResults).not.toHaveBeenCalled();
  });

  it("preserves DB group identity and MultiPV deduplication during shutdown", () => {
    const { ws, output, search } = setup(false, {
      analysisDBGroupId: "group",
      analysisDBGroupName: "Group",
    });
    search();
    ws.emit("message", "stop_engine");
    output.write("info depth 100 multipv 2 score cp 20 pv 7g7f\n");
    output.write("info depth 101 multipv 1 score cp 30 upperbound pv 7g7f\n");
    output.write("bestmove 7g7f\n");
    const [, , key, name, infos] = vi.mocked(saveAnalysisResults).mock.calls[0];
    expect([key, name]).toEqual(["group", "Group"]);
    expect([...infos.keys()]).toEqual([1]);
    expect(infos.get(1)).toMatchObject({ depth: 101, upperbound: true });
  });

  it("consumes checkmate without saving normal analysis results", () => {
    const { session, ws, engine, output } = setup();
    ws.emit("message", "position startpos");
    ws.emit("message", "go mate infinite");
    ws.emit("message", "stop_engine");
    output.write("info depth 100 score cp 20 pv 7g7f\ncheckmate timeout\n");
    expect(engine.close).toHaveBeenCalledOnce();
    expect(saveAnalysisResults).not.toHaveBeenCalled();
    expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);
  });

  it("aborts the graceful wait on a wrapper error without saving partial info", () => {
    const { session, ws, engine, output, search, remove } = setup();
    search();
    output.write("info depth 100 score cp 20 pv 7g7f\n");
    ws.emit("message", "stop_engine");
    output.write("WRAPPER_ERROR: Relay failed\n");
    expect(engine.close).toHaveBeenCalledOnce();
    expect(saveAnalysisResults).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
    expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);
  });

  it("does not remove a replacement session when the old session finishes", () => {
    const { session, ws, engine, internal, output, remove, search, disconnect } = setup();
    const sessions = new Map([[session.sessionId, session]]);
    remove.mockImplementation((id) => sessions.delete(id));
    search();
    ws.emit("message", "stop_engine");
    expect(sessions.size).toBe(0);
    const replacement = new EngineSession(session.sessionId);
    sessions.set(session.sessionId, replacement);
    disconnect();
    output.write("bestmove 7g7f\n");
    disconnect();
    internal.onEngineClose();
    expect(engine.close).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(sessions.get(session.sessionId)).toBe(replacement);
  });

  it("cancels the shutdown deadline if the engine exits before bestmove", () => {
    const { session, ws, engine, internal, output, search } = setup();
    search();
    output.write("info depth 100 score cp 20 pv 7g7f\n");
    ws.emit("message", "stop_engine");
    internal.onEngineClose();
    output.write("bestmove 7g7f\n");
    vi.advanceTimersByTime(2 * ENGINE_STOP_TIMEOUT_MS);
    expect(saveAnalysisResults).not.toHaveBeenCalled();
    expect(engine.close).not.toHaveBeenCalled();
    expect(engine.destroy).not.toHaveBeenCalled();
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(vi.getTimerCount()).toBe(0);
  });
});
