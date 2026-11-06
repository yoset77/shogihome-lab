// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { EngineSession } from "@/server/engine/session";
import { EngineState, type EngineHandle } from "@/server/engine/types";
import {
  decodeServerRelayMessage,
  encodeClientRelayMessage,
  type SessionRelayPayload,
} from "@/common/engine/relay_protocol";
import { resourceRegistry } from "@/server/engine/resources";
import { t } from "@/common/i18n";

describe("engine output boundary", () => {
  beforeEach(() => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 2 }]);
  });
  afterEach(() => {
    resourceRegistry.resetForTest();
    vi.restoreAllMocks();
  });

  function start(owner: "relay" | "internal" = "relay") {
    const remove = vi.fn();
    const session = new EngineSession("output-boundary", remove, owner);
    const internal = session as unknown as {
      engineState: EngineState;
      currentEngineId: string;
      engineHandle: EngineHandle;
      resourceLease: ReturnType<typeof resourceRegistry.acquire>;
      setupEngineHandlers(stream: PassThrough): void;
      onEngineClose(): void;
      sendToClient(data: SessionRelayPayload): void;
    };
    internal.engineState = EngineState.READY;
    internal.currentEngineId = "test";
    internal.resourceLease = resourceRegistry.acquire({ groupId: "g", cost: 1 });
    const close = vi.fn(() => internal.onEngineClose());
    internal.engineHandle = {
      write: vi.fn(),
      close,
      on: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    const output = new PassThrough();
    internal.setupEngineHandlers(output);
    const events: SessionRelayPayload[] = [];
    const ws = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      terminate: vi.fn(),
    });
    const search = {
      type: "search" as const,
      instanceId: session.internalSnapshot.instanceId,
      searchId: 1,
      position: "position startpos",
      go: "go infinite",
    };
    if (owner === "relay") {
      session.attach(ws as unknown as WebSocket);
      ws.emit("message", encodeClientRelayMessage(search));
    } else {
      session.subscribeInternal((event) => events.push(event));
      session.dispatchInternal(search);
    }
    return { session, internal, output, ws, close, remove, events };
  }

  it.each([
    "bestmove",
    "bestmove\t",
    "bestmove ",
    "bestmove invalid",
    "checkmate",
    "checkmate invalid",
  ])("confines malformed output to its own identified relay session: %s", (line) => {
    const broken = start();
    const healthy = start();
    expect(() => broken.output.write(`${line}\n`)).not.toThrow();
    expect(broken.close).toHaveBeenCalledOnce();
    expect(broken.remove).toHaveBeenCalledOnce();
    expect(broken.session.internalSnapshot).toMatchObject({
      state: EngineState.STOPPED,
      active: null,
      terminal: null,
    });
    const frames = broken.ws.send.mock.calls.map(([frame]) => decodeServerRelayMessage(frame));
    expect(frames.every((frame) => frame.ok)).toBe(true);
    expect(frames).toContainEqual({
      ok: true,
      value: expect.objectContaining({
        type: "error",
        message: `error: ${t.remoteEngineInvalidOutput}`,
      }),
    });
    expect(
      frames.some(
        (frame) => frame.ok && frame.value.type === "engineOutput" && frame.value.output === line,
      ),
    ).toBe(false);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(1);
    healthy.output.write("bestmove 7g7f\n");
    expect(healthy.session.internalSnapshot).toMatchObject({
      state: EngineState.READY,
      terminal: { output: "bestmove 7g7f" },
    });
    healthy.internal.onEngineClose();
    broken.output.end();
    healthy.output.end();
  });

  it.each([
    { line: "bestmove\t7g7f", expected: "bestmove 7g7f" },
    { line: " bestmove  7g7f\tponder 3c3d ", expected: "bestmove 7g7f ponder 3c3d" },
    { line: "checkmate\t7g7f  3c3d ", expected: "checkmate 7g7f 3c3d" },
    { line: "checkmate timeout", expected: "checkmate timeout" },
  ])(
    "canonicalizes valid terminal whitespace before relay encoding: $line",
    ({ line, expected }) => {
      const engine = start();
      expect(() => engine.output.write(`${line}\n`)).not.toThrow();
      expect(engine.close).not.toHaveBeenCalled();
      expect(engine.session.internalSnapshot.terminal?.output).toBe(expected);
      expect(engine.ws.send.mock.calls.every(([frame]) => decodeServerRelayMessage(frame).ok)).toBe(
        true,
      );
      engine.internal.onEngineClose();
      engine.output.end();
    },
  );

  it("resets a disconnected session without retaining an invalid replay snapshot", () => {
    const engine = start();
    Object.assign(engine.ws, { readyState: WebSocket.CLOSED });
    engine.ws.emit("close");
    expect(() => engine.output.write("bestmove\n")).not.toThrow();
    expect(engine.session.internalSnapshot).toMatchObject({
      state: EngineState.STOPPED,
      active: null,
      terminal: null,
    });
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    engine.output.end();
  });

  it("also terminates malformed internal output and isolates unexpected handler exceptions", async () => {
    const engine = start("internal");
    expect(() => engine.output.write("checkmate\n")).not.toThrow();
    await Promise.resolve();
    expect(engine.events).toContainEqual(
      expect.objectContaining({ type: "error", message: `error: ${t.remoteEngineInvalidOutput}` }),
    );
    expect(engine.close).toHaveBeenCalledOnce();
    engine.output.end();

    const relay = start();
    vi.spyOn(relay.internal, "sendToClient").mockImplementationOnce(() => {
      throw new Error("injected handler failure");
    });
    expect(() => relay.output.write("info string hello\n")).not.toThrow();
    expect(relay.close).toHaveBeenCalledOnce();
    relay.output.end();
  });
});
