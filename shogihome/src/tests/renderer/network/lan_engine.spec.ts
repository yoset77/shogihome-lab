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

  const installWebSocketSequence = (...sockets: MockWebSocket[]) => {
    let index = 0;
    const MockWS = vi.fn().mockImplementation(function () {
      return sockets[index++] ?? sockets.at(-1);
    });
    Object.assign(MockWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    global.WebSocket = MockWS as unknown as typeof WebSocket;
    return MockWS;
  };

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
    const MockWS = vi.fn().mockImplementation(function () {
      return mockWs;
    });
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
    const MockWS = vi.fn().mockImplementation(function () {
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
    const scheduleReconnectSpy = vi.spyOn(
      engine as unknown as { scheduleReconnect: () => void },
      "scheduleReconnect",
    );
    const promise = engine.connect();

    const expectPromise = expect(promise).rejects.toThrow("WebSocket connection error");

    if (mockWs.onerror) {
      mockWs.onerror(new Error("Network Error"));
    }

    await expectPromise;
    expect((engine as unknown as { ws: MockWebSocket | null }).ws).toBeNull();
    expect(mockWs.close).toHaveBeenCalled();
    expect(scheduleReconnectSpy).toHaveBeenCalled();
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
    engine.sendUsiCommand("stop");

    // Disconnect
    mockWs.send.mockImplementation(() => {
      // noop
    }); // Success on flush
    engine.disconnect();

    expect(mockWs.send).toHaveBeenCalledWith("stop");
    expect(mockWs.close).toHaveBeenCalled();
    expect((engine as unknown as { ws: MockWebSocket | null }).ws).toBeNull();
  });

  it("should block invalid outbound USI commands", async () => {
    const engine = new LanEngine("test-session");
    const connectPromise = engine.connect();
    mockWs.readyState = 1;
    mockWs.onopen?.();
    await connectPromise;

    engine.sendUsiCommand("setoption name USI_Hash value 1024");

    expect(mockWs.send).not.toHaveBeenCalledWith("setoption name USI_Hash value 1024");
  });

  it("should drop invalid outbound relay messages without buffering them", async () => {
    const engine = new LanEngine("test-session");
    const connectPromise = engine.connect();
    mockWs.readyState = 1;
    mockWs.onopen?.();
    await connectPromise;

    expect(() => engine.startEngine("invalid engine id")).not.toThrow();
    expect(() =>
      (
        engine as unknown as {
          sendRelayMessage: (message: unknown) => void;
        }
      ).sendRelayMessage({ type: "future" }),
    ).not.toThrow();

    expect(mockWs.send).not.toHaveBeenCalled();
    expect((engine as unknown as { commandQueue: unknown[] }).commandQueue).toEqual([]);
  });

  it.each([null, undefined, 1, {}])(
    "should drop a runtime-invalid USI command without throwing: %j",
    (command) => {
      const engine = new LanEngine("test-session");
      const sendUsiCommand = engine.sendUsiCommand as unknown as (command: unknown) => void;

      expect(() => sendUsiCommand.call(engine, command)).not.toThrow();
      expect((engine as unknown as { commandQueue: unknown[] }).commandQueue).toEqual([]);
    },
  );

  it("should warn and drop malformed frames while keeping the connection usable", async () => {
    const engine = new LanEngine("test-session");
    const onMessage = vi.fn();
    const listener = vi.fn(() => false);
    engine.addMessageListener(listener);
    const connectPromise = engine.connect(onMessage);
    mockWs.readyState = 1;
    mockWs.onopen?.();
    await connectPromise;

    mockWs.onmessage?.({ data: "{" });
    mockWs.onmessage?.({ data: JSON.stringify({ state: "ready" }) });

    expect(onMessage).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(mockWs.close).not.toHaveBeenCalled();

    mockWs.onmessage?.({
      data: JSON.stringify({ state: "ready", engineId: "test-engine" }),
    });

    expect(onMessage).toHaveBeenCalledWith({
      type: "state",
      state: "ready",
      engineId: "test-engine",
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("should cache only a validated engine list", async () => {
    const engine = new LanEngine("test-session");
    const connectPromise = engine.connect();
    mockWs.readyState = 1;
    mockWs.onopen?.();
    await connectPromise;

    const listPromise = engine.getEngineList();
    mockWs.onmessage?.({
      data: JSON.stringify({
        engineList: [{ id: "engine-1", name: "Engine", type: ["invalid"] }],
      }),
    });
    mockWs.onmessage?.({
      data: JSON.stringify({
        engineList: [{ id: "engine-1", name: "Engine", type: ["game"] }],
      }),
    });

    await expect(listPromise).resolves.toEqual([
      { id: "engine-1", name: "Engine", type: ["game"] },
    ]);
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

  it("should keep onmessage intact to preserve in-flight messages on visibility change", async () => {
    const engine = new LanEngine("test-session");
    const connectPromise = engine.connect();
    mockWs.readyState = 1;
    mockWs.onopen?.();
    await connectPromise;

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
    // onmessage must remain attached so in-flight bestmove/info is not dropped.
    expect(mockWs.onmessage).not.toBeNull();
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

  it("should deliver in-flight messages via old socket onmessage after visibility change", async () => {
    const oldWs = mockWs;
    const newWs: MockWebSocket = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
    };
    installWebSocketSequence(oldWs, newWs);

    const engine = new LanEngine("test-session");
    const onMessageHandler = vi.fn();
    const connectPromise = engine.connect(onMessageHandler);

    // Simulate successful connection (OPEN)
    oldWs.readyState = 1; // OPEN
    if (oldWs.onopen) oldWs.onopen();
    await connectPromise;

    // Track messages dispatched through the handler.
    onMessageHandler.mockClear();

    const originalVisibilityState = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });

    const onVisibilityChange = (engine as unknown as { onVisibilityChange: () => void })
      .onVisibilityChange;
    onVisibilityChange();

    newWs.readyState = 1;
    newWs.onopen?.();
    newWs.onmessage?.({ data: JSON.stringify({ state: "ready", engineId: null }) });
    onMessageHandler.mockClear();

    // Simulate a message that was already in the browser's delivery queue when
    // visibilitychange fired, arriving just after close() was called.
    const inFlightMessages = [
      JSON.stringify({ sfen: "position startpos", info: "info depth 10" }),
      JSON.stringify({ sfen: "position startpos", info: "bestmove 7g7f" }),
      JSON.stringify({ sfen: "position startpos", info: "checkmate nomate" }),
    ];
    for (const data of inFlightMessages) {
      oldWs.onmessage?.({ data });
    }

    expect(onMessageHandler.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "engineOutput",
        positionCommand: "position startpos",
        output: "info depth 10",
      },
      {
        type: "engineOutput",
        positionCommand: "position startpos",
        output: "bestmove 7g7f",
      },
      {
        type: "engineOutput",
        positionCommand: "position startpos",
        output: "checkmate nomate",
      },
    ]);

    Object.defineProperty(document, "visibilityState", {
      value: originalVisibilityState,
      writable: true,
      configurable: true,
    });
  });

  it("should keep the transport connected while refreshing after a visibility change", async () => {
    const oldWs = mockWs;
    const newWs: MockWebSocket = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
    };
    installWebSocketSequence(oldWs, newWs);

    const engine = new LanEngine("test-session");
    const statuses: string[] = [];
    engine.subscribeStatus((status) => statuses.push(status));
    const connectPromise = engine.connect();
    oldWs.readyState = WebSocket.OPEN;
    oldWs.onopen?.();
    await connectPromise;
    statuses.length = 0;

    const originalVisibilityState = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    const onVisibilityChange = (engine as unknown as { onVisibilityChange: () => void })
      .onVisibilityChange;
    onVisibilityChange();

    expect(statuses).toEqual(["connecting"]);
    newWs.readyState = WebSocket.OPEN;
    newWs.onopen?.();
    expect(statuses).toEqual(["connecting", "connected"]);

    Object.defineProperty(document, "visibilityState", {
      value: originalVisibilityState,
      writable: true,
      configurable: true,
    });
    engine.disconnect();
  });

  it("should ignore state messages from a replaced socket", async () => {
    const oldWs = mockWs;
    const newWs: MockWebSocket = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
    };
    installWebSocketSequence(oldWs, newWs);
    const engine = new LanEngine("test-session");
    const onMessageHandler = vi.fn();
    const messageListener = vi.fn(() => false);
    engine.addMessageListener(messageListener);
    const connectPromise = engine.connect(onMessageHandler);
    oldWs.readyState = 1;
    oldWs.onopen?.();
    await connectPromise;

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    (engine as unknown as { onVisibilityChange: () => void }).onVisibilityChange();
    newWs.readyState = 1;
    newWs.onopen?.();
    onMessageHandler.mockClear();

    for (const data of [
      JSON.stringify({ state: "thinking", engineId: "test-engine" }),
      JSON.stringify({ error: "stale error" }),
      JSON.stringify({ info: "pong" }),
      JSON.stringify({ engineList: [] }),
    ]) {
      oldWs.onmessage?.({ data });
    }

    expect(onMessageHandler).not.toHaveBeenCalled();
    expect(messageListener).not.toHaveBeenCalled();
  });

  it("should not replace a websocket that is still connecting on visibility change", () => {
    const MockWS = installWebSocketSequence(mockWs);
    const engine = new LanEngine("test-session");
    engine.connect().catch(() => {});
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });

    (engine as unknown as { onVisibilityChange: () => void }).onVisibilityChange();

    expect(MockWS).toHaveBeenCalledTimes(1);
    expect(mockWs.close).not.toHaveBeenCalled();
  });

  it("should reset reconnect backoff when returning to the foreground", async () => {
    const retryWs: MockWebSocket = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
    };
    const MockWS = installWebSocketSequence(mockWs, retryWs);
    const engine = new LanEngine("test-session");
    engine.connect().catch(() => {});
    (engine as unknown as { reconnectAttempts: number }).reconnectAttempts = 5;

    const originalVisibilityState = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    (engine as unknown as { onVisibilityChange: () => void }).onVisibilityChange();

    await vi.advanceTimersByTimeAsync(10000);
    expect(MockWS).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(MockWS).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWS).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", {
      value: originalVisibilityState,
      writable: true,
      configurable: true,
    });
    engine.disconnect();
  });

  it("should not let an old heartbeat timeout close the replacement socket", async () => {
    const oldWs = mockWs;
    const newWs: MockWebSocket = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
    };
    installWebSocketSequence(oldWs, newWs);
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const engine = new LanEngine("test-session");
    const connectPromise = engine.connect();
    oldWs.readyState = 1;
    oldWs.onopen?.();
    await connectPromise;
    await vi.advanceTimersByTimeAsync(6000);
    expect(oldWs.send).toHaveBeenCalledWith("ping");
    const oldPongTimeout = setTimeoutSpy.mock.calls.findLast(([, delay]) => delay === 6000)?.[0];
    expect(oldPongTimeout).toBeTypeOf("function");

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    (engine as unknown as { onVisibilityChange: () => void }).onVisibilityChange();
    newWs.readyState = 1;
    newWs.onopen?.();
    if (typeof oldPongTimeout === "function") {
      oldPongTimeout();
    }

    expect(newWs.close).not.toHaveBeenCalled();
  });

  it("should ignore a stale pong while waiting for the replacement pong", async () => {
    const oldWs = mockWs;
    const newWs: MockWebSocket = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
    };
    installWebSocketSequence(oldWs, newWs);
    const engine = new LanEngine("test-session");
    const connectPromise = engine.connect();
    oldWs.readyState = 1;
    oldWs.onopen?.();
    await connectPromise;

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    (engine as unknown as { onVisibilityChange: () => void }).onVisibilityChange();
    newWs.readyState = 1;
    newWs.onopen?.();
    await vi.advanceTimersByTimeAsync(6000);
    expect(newWs.send).toHaveBeenCalledWith("ping");

    oldWs.onmessage?.({ data: JSON.stringify({ info: "pong" }) });
    await vi.advanceTimersByTimeAsync(6000);

    expect(newWs.close).toHaveBeenCalledOnce();
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

  it("should send stop_engine before disconnecting a connected engine", async () => {
    const engine = new LanEngine("test-session");
    const connectPromise = engine.connect();
    mockWs.readyState = 1;
    mockWs.onopen?.();
    await connectPromise;

    await engine.terminateEngine();

    expect(mockWs.send).toHaveBeenCalledWith("stop_engine");
    expect(mockWs.close).toHaveBeenCalled();
  });

  it("should reconnect to send stop_engine for explicit termination", async () => {
    const engine = new LanEngine("test-session");

    const terminatePromise = engine.terminateEngine();
    mockWs.readyState = 1;
    mockWs.onopen?.();
    await terminatePromise;

    expect(mockWs.send).toHaveBeenCalledWith("stop_engine");
    expect(mockWs.close).toHaveBeenCalled();
  });

  it("should wait for an existing connecting socket before explicit termination", async () => {
    const engine = new LanEngine("test-session");
    const connectPromise = engine.connect();
    connectPromise.catch(() => {});

    const terminatePromise = engine.terminateEngine();
    await vi.advanceTimersByTimeAsync(100);

    expect(mockWs.send).not.toHaveBeenCalledWith("stop_engine");

    mockWs.readyState = 1;
    mockWs.onopen?.();
    await terminatePromise;
    await connectPromise;

    expect(mockWs.send).toHaveBeenCalledWith("stop_engine");
    expect(mockWs.close).toHaveBeenCalled();
  });

  it("should cap explicit termination reconnect wait at 3 seconds", async () => {
    const engine = new LanEngine("test-session");
    const terminatePromise = engine.terminateEngine();

    await vi.advanceTimersByTimeAsync(3000);
    await terminatePromise;

    expect(mockWs.send).not.toHaveBeenCalledWith("stop_engine");
    expect(mockWs.close).toHaveBeenCalled();
  });

  it("should cap explicit termination wait if connect does not set a socket", async () => {
    const engine = new LanEngine("test-session");
    vi.spyOn(engine, "connect").mockImplementation(() => new Promise(() => {}));

    const terminatePromise = engine.terminateEngine();
    await vi.advanceTimersByTimeAsync(3000);
    await terminatePromise;

    expect(mockWs.send).not.toHaveBeenCalledWith("stop_engine");
  });
});
