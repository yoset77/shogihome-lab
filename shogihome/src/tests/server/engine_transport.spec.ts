// @vitest-environment node
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { PassThrough } from "node:stream";
import { decodeServerRelayMessage, encodeClientRelayMessage } from "@/common/engine/relay_protocol";
import {
  createRelayMessageLimiter,
  MAX_RELAY_BUFFERED_BYTES,
  MAX_RELAY_MESSAGES,
  MAX_RELAY_RECEIVED_BYTES,
  RELAY_WINDOW_MS,
  sendRelayFrame,
} from "@/server/engine/transport";
import { EngineSession } from "@/server/engine/session";
import { EngineState } from "@/server/engine/types";

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  });
}
type TestSocket = ReturnType<typeof socket>;
const asWs = (ws: TestSocket) => ws as unknown as WebSocket;

afterEach(() => vi.useRealTimers());

it("limits message counts before decoding, including invalid and binary frames", () => {
  vi.useFakeTimers();
  const ws = socket();
  const session = new EngineSession("transport-rate");
  session.attach(asWs(ws));
  for (let i = 0; i < MAX_RELAY_MESSAGES; i++) ws.emit("message", Buffer.from("invalid"), true);
  expect(ws.close).not.toHaveBeenCalled();
  ws.emit("message", Buffer.from("ping"), false);
  expect(ws.close).toHaveBeenCalledExactlyOnceWith(1008, expect.any(String));
  const sent = ws.send.mock.calls.length;
  ws.emit("message", Buffer.from("ping"), false);
  expect(ws.send).toHaveBeenCalledTimes(sent);
  vi.advanceTimersByTime(1000);
  expect(ws.terminate).toHaveBeenCalledOnce();
});

it("counts raw bytes and resets the receive window", () => {
  vi.useFakeTimers();
  const ws = socket();
  const accept = createRelayMessageLimiter(asWs(ws));
  expect(accept(Buffer.alloc(MAX_RELAY_RECEIVED_BYTES))).toBe(true);
  vi.advanceTimersByTime(RELAY_WINDOW_MS);
  expect(accept([Buffer.alloc(MAX_RELAY_RECEIVED_BYTES - 1), Buffer.alloc(1)])).toBe(true);
  expect(accept("é")).toBe(false);
  ws.emit("close");
  vi.advanceTimersByTime(1000);
  expect(ws.terminate).not.toHaveBeenCalled();
});

it("includes the next frame's UTF-8 bytes in the send budget", () => {
  const ws = socket();
  ws.bufferedAmount = MAX_RELAY_BUFFERED_BYTES - 12;
  expect(sendRelayFrame(asWs(ws), "é")).toBe(true);
  expect(sendRelayFrame(asWs(ws), "éé")).toBe(false);
  expect(ws.terminate).toHaveBeenCalledOnce();
  expect(sendRelayFrame(asWs(ws), "a")).toBe(false);
  expect(ws.send).toHaveBeenCalledTimes(1);
});

it("isolates synchronous send failures", () => {
  const ws = socket();
  ws.send.mockImplementation(() => {
    throw new Error("transport failed");
  });
  expect(sendRelayFrame(asWs(ws), "frame")).toBe(false);
  expect(ws.terminate).toHaveBeenCalledOnce();
});

it("bounds replay when a reconnecting socket is already congested", () => {
  const session = new EngineSession("transport-replay");
  const slow = socket();
  slow.bufferedAmount = MAX_RELAY_BUFFERED_BYTES;
  session.attach(asWs(slow));
  expect(slow.terminate).toHaveBeenCalledOnce();
  expect(slow.send).not.toHaveBeenCalled();
  const replacement = socket();
  session.attach(asWs(replacement));
  slow.emit("close");
  replacement.emit("message", Buffer.from("ping"), false);
  expect(replacement.send).toHaveBeenCalledWith(expect.stringContaining('"pong"'));
  replacement.emit("close");
});

it("restores a search result after disconnecting a slow consumer", () => {
  vi.useFakeTimers();
  const session = new EngineSession("transport-search");
  const internal = session as unknown as {
    engineState: EngineState;
    currentEngineId: string;
    engineHandle: {
      write: ReturnType<typeof vi.fn>;
      close: () => void;
      removeAllListeners: () => void;
    };
    setupEngineHandlers(stream: PassThrough): void;
    onEngineClose(): void;
  };
  internal.engineState = EngineState.READY;
  internal.currentEngineId = "test";
  internal.engineHandle = {
    write: vi.fn(),
    close: () => internal.onEngineClose(),
    removeAllListeners: () => {},
  };
  const output = new PassThrough();
  internal.setupEngineHandlers(output);
  const slow = socket();
  slow.terminate.mockImplementation(() => {
    slow.readyState = WebSocket.CLOSED;
    slow.emit("close");
  });
  session.attach(asWs(slow));
  slow.emit(
    "message",
    Buffer.from(
      encodeClientRelayMessage({
        type: "search",
        instanceId: session.internalSnapshot.instanceId,
        searchId: 1,
        position: "position startpos",
        go: "go infinite",
      }),
    ),
    false,
  );
  slow.bufferedAmount = MAX_RELAY_BUFFERED_BYTES;
  output.write("info depth 1 score cp 0 pv 7g7f\n");
  expect(slow.terminate).toHaveBeenCalledOnce();
  output.write("bestmove 7g7f\n");
  const replacement = socket();
  session.attach(asWs(replacement));
  const frames = replacement.send.mock.calls.map(([frame]) => decodeServerRelayMessage(frame));
  expect(frames).toContainEqual(
    expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        type: "searchSnapshot",
        terminal: expect.objectContaining({ searchId: 1, output: "bestmove 7g7f" }),
      }),
    }),
  );
  expect(frames).toContainEqual(
    expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ type: "engineOutput", output: "bestmove 7g7f" }),
    }),
  );
  replacement.emit("message", Buffer.from("stop_engine"), false);
  replacement.emit("close");
  output.end();
  expect(vi.getTimerCount()).toBe(0);
});
