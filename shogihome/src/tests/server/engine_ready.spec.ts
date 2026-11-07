// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import {
  decodeServerRelayMessage,
  encodeClientRelayMessage,
  type ClientRelayMessage,
} from "@/common/engine/relay_protocol";
import { t } from "@/common/i18n";
import {
  CONNECTION_PROTECTION_TIMEOUT,
  ENGINE_STOP_TIMEOUT_MS,
  RELAY_READY_TIMEOUT_MS,
} from "@/server/config";
import { resourceRegistry, type ResourceLease } from "@/server/engine/resources";
import { EngineSession } from "@/server/engine/session";
import { EngineState } from "@/server/engine/types";

vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  });
}

function setup() {
  const session = new EngineSession("ready");
  const ws = socket();
  const engine = { write: vi.fn(), close: vi.fn(), destroy: vi.fn(), removeAllListeners: vi.fn() };
  const internal = session as unknown as {
    engineState: EngineState;
    currentEngineId: string;
    engineHandle: typeof engine;
    resourceLease?: ResourceLease;
    setupEngineHandlers(stream: PassThrough): void;
    onEngineClose(): void;
  };
  internal.engineState = EngineState.WAITING_USIOK;
  internal.currentEngineId = "test";
  internal.engineHandle = engine;
  const output = new PassThrough();
  internal.setupEngineHandlers(output);
  session.attach(ws as unknown as WebSocket);
  const send = (message: ClientRelayMessage) =>
    ws.emit("message", encodeClientRelayMessage(message));
  const startNextGame = () => {
    output.write("usiok\nreadyok\n");
    send({ type: "usi", command: "usinewgame" });
    send({ type: "usi", command: "gameover draw" });
    engine.write.mockClear();
    ws.send.mockClear();
    send({ type: "usi", command: "usinewgame" });
  };
  const messages = () =>
    ws.send.mock.calls.map(([frame]) => {
      const decoded = decodeServerRelayMessage(frame);
      if (!decoded.ok) throw new Error(decoded.error);
      return decoded.value;
    });
  return { session, ws, engine, internal, output, send, startNextGame, messages };
}

describe("relay readiness deadlines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    resourceRegistry.resetForTest();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("preserves the caller's startup timeout and reuses startup readiness for the first game", () => {
    const { session, engine, output, send, messages } = setup();
    send({ type: "usi", command: "usinewgame" });
    vi.advanceTimersByTime(RELAY_READY_TIMEOUT_MS + 1);
    expect(session.internalSnapshot.state).toBe(EngineState.WAITING_USIOK);
    output.write("usiok\n");
    expect(session.internalSnapshot.state).toBe(EngineState.WAITING_READYOK);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(RELAY_READY_TIMEOUT_MS + 1);
    expect(engine.close).not.toHaveBeenCalled();
    output.write("readyok\n");
    expect(engine.write.mock.calls.map(([command]) => command)).toEqual([
      "isready\n",
      "usinewgame\n",
    ]);
    expect(session.internalSnapshot.state).toBe(EngineState.READY);
    expect(messages().filter((message) => message.type === "error")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "closes an unresponsive engine and retains its lease until transport destruction (identified: %s)",
    (identified) => {
      const { session, engine, internal, output, send, startNextGame, messages } = setup();
      resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 4 }]);
      internal.resourceLease = resourceRegistry.acquire({ groupId: "g", cost: 4 });
      startNextGame();
      if (identified) {
        send({
          type: "search",
          instanceId: session.internalSnapshot.instanceId,
          searchId: 1,
          position: "position startpos",
          go: "go infinite",
        });
      } else {
        send({ type: "usi", command: "position startpos" });
        send({ type: "usi", command: "go infinite" });
      }
      expect(engine.write).toHaveBeenCalledExactlyOnceWith("isready\n");
      vi.advanceTimersByTime(RELAY_READY_TIMEOUT_MS - 1);
      expect(engine.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(messages()).toContainEqual({
        type: "error",
        message: `error: ${t.remoteEngineReadyTimedOut}`,
        delay: 0,
      });
      expect(engine.close).toHaveBeenCalledOnce();
      expect(engine.destroy).not.toHaveBeenCalled();
      expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
      output.write("readyok\nbestmove 7g7f\n");
      expect(engine.write).toHaveBeenCalledExactlyOnceWith("isready\n");
      engine.destroy.mockImplementation(() => {
        expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
      });
      vi.advanceTimersByTime(ENGINE_STOP_TIMEOUT_MS - 1);
      expect(engine.destroy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(engine.destroy).toHaveBeenCalledOnce();
      expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
      expect(messages()).toContainEqual({ type: "notice", notice: "engineStopped", delay: 0 });
      output.write("readyok\n");
      expect(engine.write).toHaveBeenCalledExactlyOnceWith("isready\n");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("clears the deadline before starting queued commands and searches on readyok", () => {
    const { session, ws, engine, output, send, startNextGame, messages } = setup();
    startNextGame();
    send({
      type: "search",
      instanceId: session.internalSnapshot.instanceId,
      searchId: 1,
      position: "position startpos",
      go: "go infinite",
    });
    vi.advanceTimersByTime(RELAY_READY_TIMEOUT_MS - 1);
    ws.send.mockClear();
    output.write("readyok\n");
    expect(engine.write.mock.calls.map(([command]) => command)).toEqual([
      "isready\n",
      "usinewgame\n",
      "position startpos\n",
      "go infinite\n",
    ]);
    expect(session.internalSnapshot.active).toBe(1);
    expect(
      messages().map((message) => {
        switch (message.type) {
          case "engineOutput":
            return `output:${message.output}`;
          case "state":
            return `state:${message.state}`;
          case "notice":
            return `notice:${message.notice}`;
          case "searchSnapshot":
            return `snapshot:${message.active}`;
          default:
            return message.type;
        }
      }),
    ).toEqual([
      "output:readyok",
      "state:ready",
      "notice:engineReady",
      "state:thinking",
      "snapshot:1",
      "snapshot:1",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(RELAY_READY_TIMEOUT_MS + ENGINE_STOP_TIMEOUT_MS);
    expect(engine.close).not.toHaveBeenCalled();
    expect(messages().filter((message) => message.type === "error")).toEqual([]);
  });

  it("preserves a new readiness deadline started while replaying queued commands", () => {
    const { session, engine, internal, output, send, startNextGame } = setup();
    startNextGame();
    send({ type: "usi", command: "usinewgame" });
    vi.advanceTimersByTime(10_000);
    output.write("readyok\n");
    expect(engine.write.mock.calls.map(([command]) => command)).toEqual([
      "isready\n",
      "usinewgame\n",
      "isready\n",
    ]);
    expect(session.internalSnapshot.state).toBe(EngineState.WAITING_READYOK);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(RELAY_READY_TIMEOUT_MS - 1);
    expect(engine.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(engine.close).toHaveBeenCalledOnce();
    internal.onEngineClose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "keeps the original deadline across browser disconnection (reattach: %s)",
    (reattach) => {
      const { session, ws, engine, startNextGame } = setup();
      startNextGame();
      vi.advanceTimersByTime(10_000);
      ws.readyState = WebSocket.CLOSED;
      ws.emit("close");
      if (reattach) {
        const replacement = socket();
        session.attach(replacement as unknown as WebSocket);
        for (const message of [
          { type: "startEngine", engineId: "test" },
          { type: "usi", command: "usinewgame" },
          { type: "usi", command: "isready" },
        ] satisfies ClientRelayMessage[]) {
          replacement.emit("message", encodeClientRelayMessage(message));
        }
      }
      vi.advanceTimersByTime(RELAY_READY_TIMEOUT_MS - 10_001);
      expect(engine.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(engine.close).toHaveBeenCalledOnce();
      expect(engine.write).toHaveBeenCalledExactlyOnceWith("isready\n");
      vi.advanceTimersByTime(CONNECTION_PROTECTION_TIMEOUT + ENGINE_STOP_TIMEOUT_MS);
      expect(engine.close).toHaveBeenCalledOnce();
      expect(engine.destroy).toHaveBeenCalledOnce();
      expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["stopEngine", "engine exit", "wrapper error"])(
    "clears the readiness deadline on %s",
    (reason) => {
      const { session, engine, internal, output, send, startNextGame, messages } = setup();
      startNextGame();
      vi.advanceTimersByTime(5000);
      if (reason === "stopEngine") send({ type: "stopEngine" });
      else if (reason === "engine exit") internal.onEngineClose();
      else output.write("WRAPPER_ERROR: Relay failed\n");
      expect(vi.getTimerCount()).toBe(reason === "engine exit" ? 0 : 1);
      const errors = messages().filter((message) => message.type === "error");
      vi.advanceTimersByTime(RELAY_READY_TIMEOUT_MS + ENGINE_STOP_TIMEOUT_MS);
      expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
      expect(messages().filter((message) => message.type === "error")).toEqual(errors);
      expect(engine.write).toHaveBeenCalledExactlyOnceWith("isready\n");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
