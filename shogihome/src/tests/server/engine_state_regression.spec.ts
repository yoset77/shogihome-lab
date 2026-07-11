import { EngineSession } from "@/server/engine/session";
import { EngineState } from "@/server/engine/types";
import { saveAnalysisResults } from "@/server/database/sqlite";
import { vi, describe, it, expect, beforeEach, type Mock } from "vitest";
import { PassThrough } from "stream";

vi.mock("@/server/database/sqlite", () => ({
  saveAnalysisResults: vi.fn(),
}));

const mockSaveAnalysisResults = vi.mocked(saveAnalysisResults);

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
  handleDisconnect(socket: MockExtendedWebSocket): void;
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
    mockSaveAnalysisResults.mockClear();
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

  it("should sendError for setoption when engine is STOPPED, not silently drop", () => {
    tSession.engineState = EngineState.STOPPED;
    tSession.engineHandle = null;

    tSession.handleMessage("setoption name MultiPV value 3");

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining("error"));
    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining("engine not ready"));
  });

  it("should sendError for setoption when engine is UNINITIALIZED, not queue", () => {
    tSession.engineState = EngineState.UNINITIALIZED;
    tSession.engineHandle = null;

    tSession.handleMessage("setoption name MultiPV value 3");

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining("error"));
    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining("engine not ready"));
  });

  it("should queue setoption when engine is WAITING_READYOK", () => {
    const queue: string[] = [];
    tSession.engineState = EngineState.WAITING_READYOK;
    tSession.engineHandle = null;
    // Access private commandQueue via reflection-free approach: the pushToQueue appends to commandQueue
    const cmdQueue = tSession as unknown as { commandQueue: string[] };
    cmdQueue.commandQueue = queue;

    tSession.handleMessage("setoption name MultiPV value 3");

    expect(queue).toContain("setoption name MultiPV value 3");
    expect(mockWs.send).not.toHaveBeenCalledWith(expect.stringContaining("error"));
  });

  it.each([EngineState.STOPPED, EngineState.UNINITIALIZED])(
    "should reject game lifecycle commands when engine is in state %s",
    (state) => {
      const commandQueue: string[] = [];
      tSession.engineState = state;
      (tSession as unknown as { commandQueue: string[] }).commandQueue = commandQueue;

      tSession.handleMessage("usinewgame");
      tSession.handleMessage("gameover lose");

      expect(commandQueue).toHaveLength(0);
      expect(mockWs.send).toHaveBeenCalledTimes(2);
      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining("engine not ready"));
    },
  );

  it("should ignore commands from a replaced websocket", () => {
    tSession.engineState = EngineState.THINKING;
    const engineHandle = {
      write: vi.fn(),
      close: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    tSession.engineHandle = engineHandle;
    const oldMessageListener = mockWs.on.mock.calls.find(([event]) => event === "message")?.[1];
    expect(oldMessageListener).toBeTypeOf("function");
    const replacementWs: MockExtendedWebSocket = {
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      readyState: 1,
    };

    session.attach(replacementWs as unknown as Parameters<EngineSession["attach"]>[0]);
    oldMessageListener!("stop_engine");

    expect(tSession.engineState).toBe(EngineState.THINKING);
    expect(engineHandle.close).not.toHaveBeenCalled();
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

  it("should keep the engine alive when reconnecting after multiple position updates", async () => {
    const stream = new PassThrough();
    const engineHandle = {
      write: vi.fn(),
      close: vi.fn(() => tSession.onEngineClose()),
      removeAllListeners: vi.fn(),
    };
    tSession.engineState = EngineState.THINKING;
    tSession.engineHandle = engineHandle;
    tSession.setupEngineHandlers(stream);

    tSession.handleDisconnect(mockWs);

    expect(engineHandle.close).not.toHaveBeenCalled();
    expect(tSession.engineState).toBe(EngineState.THINKING);

    const reconnectedWs: MockExtendedWebSocket = {
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      readyState: 1,
    };
    session.attach(reconnectedWs as unknown as Parameters<EngineSession["attach"]>[0]);

    tSession.handleMessage("position startpos moves 7g7f");
    tSession.handleMessage("go infinite");
    tSession.handleMessage("position startpos moves 2g2f");
    tSession.handleMessage("go infinite");

    expect(engineHandle.close).not.toHaveBeenCalled();
    expect(engineHandle.write).toHaveBeenCalledWith("stop\n");
    expect(tSession.engineState).toBe(EngineState.STOPPING_SEARCH);

    stream.write("bestmove resign\n");

    await vi.waitFor(() => {
      expect(tSession.engineState).toBe(EngineState.THINKING);
    });
    expect(engineHandle.close).not.toHaveBeenCalled();
    expect(engineHandle.write).toHaveBeenCalledWith("position startpos moves 2g2f\n");
    expect(engineHandle.write).toHaveBeenCalledWith("go infinite\n");
    expect(engineHandle.write).not.toHaveBeenCalledWith("position startpos moves 7g7f\n");
  });

  it("should save bounded PVs when MultiPV order changes before bestmove", async () => {
    const stream = new PassThrough();
    tSession.engineState = EngineState.THINKING;
    (
      tSession as unknown as { currentEngineConfig: { id: string; name: string } }
    ).currentEngineConfig = { id: "test-engine", name: "Test Engine" };
    (tSession as unknown as { pendingGoSfen: string }).pendingGoSfen = "position startpos";
    tSession.setupEngineHandlers(stream);

    // Insert PV2 first to ensure priority is based on MultiPV rank, not Map insertion order.
    stream.write("info depth 100 multipv 2 score cp 100 pv 2g2f 8c8d\n");
    stream.write("info depth 100 multipv 1 score cp 200 pv 7g7f 3c3d\n");
    stream.write("info depth 101 multipv 1 score cp 150 upperbound pv 2g2f 8c8d\n");
    stream.write("info depth 110 multipv 2 score cp 210 pv 7g7f 3c3d\n");
    stream.write("bestmove 7g7f\n");

    await vi.waitFor(() => expect(mockSaveAnalysisResults).toHaveBeenCalledOnce());
    const savedInfos = mockSaveAnalysisResults.mock.calls[0][4];
    expect([...savedInfos.keys()]).toEqual([1, 2]);
    expect(savedInfos.get(1)).toEqual(
      expect.objectContaining({
        pv: ["2g2f", "8c8d"],
        depth: 101,
        upperbound: true,
      }),
    );
    expect(savedInfos.get(2)).toEqual(
      expect.objectContaining({
        pv: ["7g7f", "3c3d"],
        depth: 110,
      }),
    );
  });

  it("should clear a previous bound when an exact score arrives", async () => {
    const stream = new PassThrough();
    tSession.engineState = EngineState.THINKING;
    (
      tSession as unknown as { currentEngineConfig: { id: string; name: string } }
    ).currentEngineConfig = { id: "test-engine", name: "Test Engine" };
    (tSession as unknown as { pendingGoSfen: string }).pendingGoSfen = "position startpos";
    tSession.setupEngineHandlers(stream);

    stream.write("info depth 100 score cp 100 lowerbound pv 7g7f\n");
    stream.write("info depth 101 score mate 5 pv 7g7f 3c3d\n");
    stream.write("bestmove 7g7f\n");

    await vi.waitFor(() => expect(mockSaveAnalysisResults).toHaveBeenCalledOnce());
    const savedInfo = mockSaveAnalysisResults.mock.calls[0][4].get(1);
    expect(savedInfo).toEqual(expect.objectContaining({ scoreMate: 5, pv: ["7g7f", "3c3d"] }));
    expect(savedInfo?.scoreCP).toBeUndefined();
    expect(savedInfo?.lowerbound).toBeUndefined();
    expect(savedInfo?.upperbound).toBeUndefined();
  });

  it("should save all PVs when their first moves are distinct", async () => {
    const stream = new PassThrough();
    tSession.engineState = EngineState.THINKING;
    (
      tSession as unknown as { currentEngineConfig: { id: string; name: string } }
    ).currentEngineConfig = { id: "test-engine", name: "Test Engine" };
    (tSession as unknown as { pendingGoSfen: string }).pendingGoSfen = "position startpos";
    tSession.setupEngineHandlers(stream);

    stream.write("info depth 100 multipv 2 score cp 100 pv 2g2f 8c8d\n");
    stream.write("info depth 100 multipv 1 score cp 200 pv 7g7f 3c3d\n");
    stream.write("bestmove 7g7f\n");

    await vi.waitFor(() => expect(mockSaveAnalysisResults).toHaveBeenCalledOnce());
    const savedInfos = mockSaveAnalysisResults.mock.calls[0][4];
    expect([...savedInfos.keys()]).toEqual([1, 2]);
    expect(savedInfos.get(1)?.pv?.[0]).toBe("7g7f");
    expect(savedInfos.get(2)?.pv?.[0]).toBe("2g2f");
  });
});
