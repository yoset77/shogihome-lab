// eslint-disable-next-line no-restricted-imports
import { EngineSession, EngineState } from "../../../server";
import { vi, describe, it, expect, beforeEach, type Mock } from "vitest";

// Define a type that matches the internal structure of EngineSession for testing
type TestableEngineSession = {
  engineState: EngineState;
  engineHandle: {
    write: Mock<(command: string) => void>;
    close: Mock<() => void>;
    removeAllListeners: Mock<() => void>;
  } | null;
  postStopCommandQueue: string[];
  handleMessage(command: string): void;
  onEngineClose(): void;
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

  it("should move start_engine and stop_engine out of postStopCommandQueue", () => {
    tSession.engineState = EngineState.STOPPING_SEARCH;

    tSession.handleMessage("start_engine dummy");
    // If it was queued, postStopCommandQueue would have 1 item.
    // But it should be handled immediately.
    expect(tSession.postStopCommandQueue.length).toBe(0);
  });
});
