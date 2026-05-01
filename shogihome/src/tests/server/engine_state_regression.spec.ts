import { EngineSession } from "@/server/engine/session";
import { EngineState } from "@/server/engine/types";
import { vi, describe, it, expect, beforeEach, type Mock } from "vitest";
import { PassThrough } from "stream";

// Define a type that matches the internal structure of EngineSession for testing
type TestableEngineSession = {
  engineState: EngineState;
  engineHandle: {
    write: Mock<(command: string) => void>;
    close: Mock<() => void>;
    removeAllListeners: Mock<() => void>;
  } | null;
  postStopCommandQueue: string[];
  messageBuffer: { data: unknown; createdAt: number }[];
  handleMessage(command: string): void;
  onEngineClose(): void;
  sendToClient(data: unknown): void;
  setupEngineHandlers(stream: NodeJS.ReadableStream): void;
};

interface MockExtendedWebSocket {
  send: Mock<(data: string) => void>;
  terminate: Mock<() => void>;
  close: Mock<() => void>;
  on: Mock<(event: string, listener: (data: string) => void) => void>;
  readyState: number;
}

describe("Engine State Regression Tests", () => {
  let session: EngineSession;
  let tSession: TestableEngineSession;
  let mockWs: MockExtendedWebSocket;

  beforeEach(() => {
    mockWs = {
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      readyState: 1, // OPEN
    };
    session = new EngineSession("test-session");
    tSession = session as unknown as TestableEngineSession;
    session.attach(mockWs as unknown as Parameters<EngineSession["attach"]>[0]);
    mockWs.send.mockClear();
  });

  it("should handle stop_engine immediately during STOPPING_SEARCH", async () => {
    // 1. Move to THINKING
    tSession.engineState = EngineState.THINKING;
    tSession.engineHandle = {
      write: vi.fn(),
      close: vi.fn(() => tSession.onEngineClose()),
      removeAllListeners: vi.fn(),
    };

    // 2. Trigger stop to enter STOPPING_SEARCH
    tSession.handleMessage("stop");
    expect(tSession.engineState).toBe(EngineState.STOPPING_SEARCH);

    // 3. Send stop_engine while in STOPPING_SEARCH
    tSession.handleMessage("stop_engine");

    // Verification: State should be STOPPED
    expect(tSession.engineState).toBe(EngineState.STOPPED);
    expect(tSession.engineHandle).toBeNull();
  });

  it("should trim whitespace around websocket commands", () => {
    tSession.engineState = EngineState.THINKING;
    tSession.engineHandle = {
      write: vi.fn(),
      close: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    tSession.handleMessage("stop ");

    expect(tSession.engineState).toBe(EngineState.STOPPING_SEARCH);
    expect(tSession.engineHandle.write).toHaveBeenCalledWith("stop\n");
  });

  it("should move start_engine and stop_engine out of postStopCommandQueue", () => {
    tSession.engineState = EngineState.STOPPING_SEARCH;

    tSession.handleMessage("start_engine dummy");
    // If it was queued, postStopCommandQueue would have 1 item.
    // But it should be handled immediately.
    expect(tSession.postStopCommandQueue.length).toBe(0);
  });

  it("should reset engine state on authentication failure", async () => {
    // 1. Move to STARTING
    tSession.engineState = EngineState.STARTING;
    (tSession as unknown as { currentEngineId: string }).currentEngineId = "test-engine";
    tSession.engineHandle = null;

    // 2. Mock a failed authentication and trigger rollback logic
    // In server.ts, startEngine's catch block calls onEngineClose()
    tSession.onEngineClose();

    // Verification: State should be STOPPED and ID cleared
    expect(tSession.engineState).toBe(EngineState.STOPPED);
    expect((tSession as unknown as { currentEngineId: string | null }).currentEngineId).toBeNull();
  });

  it("should not replay go before a newer queued position after stop", async () => {
    const stream = new PassThrough();
    tSession.engineState = EngineState.STOPPING_SEARCH;
    tSession.engineHandle = {
      write: vi.fn(),
      close: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    tSession.postStopCommandQueue.push(
      "position startpos moves 7g7f",
      "go infinite",
      "position startpos moves 2g2f",
    );
    tSession.setupEngineHandlers(stream);

    stream.write("bestmove 7g7f\n");

    await vi.waitFor(() => {
      expect(tSession.engineState).toBe(EngineState.READY);
    });
    expect(tSession.engineHandle.write).toHaveBeenCalledTimes(1);
    expect(tSession.engineHandle.write).toHaveBeenCalledWith("position startpos moves 2g2f\n");
  });

  it("should not send late bestmove while terminating", async () => {
    const stream = new PassThrough();
    tSession.engineState = EngineState.TERMINATING;
    tSession.engineHandle = {
      write: vi.fn(),
      close: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    tSession.setupEngineHandlers(stream);

    stream.write("bestmove 7g7f\n");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWs.send).not.toHaveBeenCalledWith(expect.stringContaining("bestmove"));
  });

  it("should cap disconnected message buffer size", () => {
    (tSession as unknown as { ws: null }).ws = null;

    for (let i = 0; i < 80; i++) {
      tSession.sendToClient({ info: `debug line ${i}` });
    }

    expect(tSession.messageBuffer.length).toBeLessThanOrEqual(50);
  });
});
