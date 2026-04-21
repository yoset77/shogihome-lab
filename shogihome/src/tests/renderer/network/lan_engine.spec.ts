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

    const expectPromise = expect(promise).rejects.toThrow("WebSocket connection timeout");

    await vi.advanceTimersByTimeAsync(11000);

    await expectPromise;
    expect(mockWs.close).toHaveBeenCalled();

    engine.disconnect();
    // Ensure all timers are cleared to avoid unhandled rejection in subsequent tests
    await vi.runAllTimersAsync();
  });

  it("should schedule reconnect after connection timeout", async () => {
    const engine = new LanEngine("test-session");
    const scheduleReconnectSpy = vi.spyOn(
      engine as unknown as { scheduleReconnect: () => void },
      "scheduleReconnect",
    );
    const promise = engine.connect();
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(11000);
    // タイムアウト後に scheduleReconnect が呼ばれること
    expect(scheduleReconnectSpy).toHaveBeenCalled();
    engine.disconnect();
    await vi.runAllTimersAsync();
  });

  it("should not destroy new connection when stale timeout fires", async () => {
    let mockWs2: MockWebSocket | undefined;
    let callCount = 0;
    const MockWS = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockWs; // ws1（タイムアウトする接続）
      mockWs2 = {
        readyState: 0,
        send: vi.fn(),
        close: vi.fn(),
        onopen: null,
        onerror: null,
        onclose: null,
        onmessage: null,
      };
      return mockWs2;
    });
    Object.assign(MockWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    global.WebSocket = MockWS as unknown as typeof WebSocket;

    const engine = new LanEngine("test-session");

    // ws1 で接続開始
    const p1 = engine.connect();
    p1.catch(() => {});

    // 10秒以内に disconnect → reconnect
    engine.disconnect();
    const p2 = engine.connect();
    // ws2 が開く
    mockWs2!.readyState = 1;
    if (mockWs2!.onopen) mockWs2!.onopen();
    await p2; // ws2 は正常接続

    // ws1 の stale タイムアウトが発火しても ws2 は無傷
    await vi.advanceTimersByTimeAsync(11000);

    expect((engine as unknown as { ws: unknown }).ws).toBe(mockWs2);
    expect(mockWs2!.close).not.toHaveBeenCalled(); // ws2 は close されない

    engine.disconnect();
    await vi.runAllTimersAsync();
  });

  it("should reject connect() on connection error", async () => {
    const engine = new LanEngine("test-session");
    const promise = engine.connect();

    const expectPromise = expect(promise).rejects.toThrow("WebSocket connection error");

    if (mockWs.onerror) {
      mockWs.onerror(new Error("Network Error"));
    }

    await expectPromise;
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

  it("should remove all listeners before closing socket on disconnect", async () => {
    const engine = new LanEngine("test-session");

    // Start connecting
    const connectPromise = engine.connect();
    // Suppress unhandled rejection since connect() will reject when we close the socket or timeout
    connectPromise.catch(() => {});

    // Before connection establishes, they should be set
    expect(mockWs.onopen).not.toBeNull();
    expect(mockWs.onmessage).not.toBeNull();
    expect(mockWs.onerror).not.toBeNull();
    expect(mockWs.onclose).not.toBeNull();

    engine.disconnect();

    // They should be nullified
    expect(mockWs.onopen).toBeNull();
    expect(mockWs.onmessage).toBeNull();
    expect(mockWs.onerror).toBeNull();
    expect(mockWs.onclose).toBeNull();
    expect(mockWs.close).toHaveBeenCalled();
  });

  it("should remove all listeners before closing socket on visibility change", async () => {
    const engine = new LanEngine("test-session");
    const connectPromise = engine.connect();
    connectPromise.catch(() => {});

    expect(mockWs.onopen).not.toBeNull();

    // Prevent connect() from overwriting mockWs properties
    vi.spyOn(engine, "connect").mockImplementation(() => Promise.resolve());

    // Mock document.visibilityState
    const originalVisibilityState = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });

    // Simulate visibility change
    const onVisibilityChange = (engine as unknown as { onVisibilityChange: () => void })
      .onVisibilityChange;
    onVisibilityChange();

    expect(mockWs.onopen).toBeNull();
    expect(mockWs.onmessage).toBeNull();
    expect(mockWs.onerror).toBeNull();
    expect(mockWs.onclose).toBeNull();
    expect(mockWs.close).toHaveBeenCalled();

    // Clean up
    Object.defineProperty(document, "visibilityState", {
      value: originalVisibilityState,
      writable: true,
      configurable: true,
    });
  });

  it("should schedule reconnect when socket closes before onopen", async () => {
    const engine = new LanEngine("test-session");

    // Start connecting
    const connectPromise = engine.connect();
    connectPromise.catch(() => {}); // ignore rejection

    const scheduleReconnectSpy = vi.spyOn(
      engine as unknown as { scheduleReconnect: () => void },
      "scheduleReconnect",
    );

    // Close before open
    if (mockWs.onclose) {
      mockWs.onclose({ code: 1006, reason: "abnormal closure" });
    }

    expect(scheduleReconnectSpy).toHaveBeenCalled();
  });
});
