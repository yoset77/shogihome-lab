import { LanEngine } from "@/renderer/network/lan_engine";
import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from "vitest";

interface MockWebSocket {
  readyState: number;
  send: Mock<(data: string) => void>;
  close: Mock<() => void>;
  onopen: (() => void) | null;
  onerror: ((err: Error) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

describe("LanEngine", () => {
  let mockWs: MockWebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWs = {
      readyState: 0, // CONNECTING
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
    };
    // Mock WebSocket globally
    const MockWS = vi.fn().mockImplementation(() => mockWs);
    Object.assign(MockWS, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    });
    global.WebSocket = MockWS as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should reject connect() on timeout", async () => {
    const engine = new LanEngine("test-session");
    const promise = engine.connect();

    await vi.advanceTimersByTimeAsync(11000);

    await expect(promise).rejects.toThrow("WebSocket connection timeout");
    expect(mockWs.close).toHaveBeenCalled();
  });

  it("should reject connect() on connection error", async () => {
    const engine = new LanEngine("test-session");
    const promise = engine.connect();

    if (mockWs.onerror) {
      mockWs.onerror(new Error("Network Error"));
    }

    await expect(promise).rejects.toThrow("WebSocket connection error");
  });

  it("should flush command queue and close socket on disconnect", async () => {
    const engine = new LanEngine("test-session");

    // Simulate connection
    const connectPromise = engine.connect();
    mockWs.readyState = 1; // OPEN
    if (mockWs.onopen) mockWs.onopen();
    await connectPromise;

    // Buffering command (simulate send failure)
    mockWs.send.mockImplementation(() => {
      throw new Error("Send failed");
    });
    engine.sendCommand("test-command");

    // Disconnect
    mockWs.send.mockImplementation(() => {
      // noop
    }); // Success on flush
    engine.disconnect();

    expect(mockWs.send).toHaveBeenCalledWith("test-command");
    expect(mockWs.close).toHaveBeenCalled();
    expect((engine as unknown as { ws: MockWebSocket | null }).ws).toBeNull();
  });
});
