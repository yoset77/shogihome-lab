// @vitest-environment node
import { EventEmitter } from "node:events";
import net from "node:net";
import { WebSocket } from "ws";
import { EngineSession } from "@/server/engine/session";
import { engineConfigCache, fetchEngineConfigs } from "@/server/engine/list";
import { resourceRegistry } from "@/server/engine/resources";
import { EngineState, type EngineConfig } from "@/server/engine/types";

vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));
vi.mock("@/server/engine/list", async (original) => ({
  ...(await original<typeof import("@/server/engine/list")>()),
  fetchEngineConfigs: vi.fn(),
}));

describe("relay resource admission", () => {
  const config: EngineConfig = {
    id: "test",
    name: "Test",
    threads: 4,
    resource: { groupId: "g" },
  };
  let socket: EventEmitter & { readyState: number; send: ReturnType<typeof vi.fn> };
  let connect: ReturnType<typeof vi.spyOn>;
  let session: EngineSession;

  beforeEach(() => {
    engineConfigCache.clear();
    resourceRegistry.resetForTest();
    connect = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
      this: net.Socket,
    ) {
      return this;
    });
    socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    });
    session = new EngineSession("resource-start");
    session.attach(socket as unknown as Parameters<EngineSession["attach"]>[0]);
    socket.send.mockClear();
  });

  afterEach(async () => {
    socket.emit("message", "stop_engine");
    await new Promise(setImmediate);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resourceRegistry.resetForTest();
    engineConfigCache.clear();
  });

  function discover(budget: number) {
    vi.mocked(fetchEngineConfigs).mockImplementation(async () => {
      resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget }] });
      return [config];
    });
  }

  it("rejects a cold-cache start using the wrapper's budget without browser discovery", async () => {
    discover(2);
    socket.emit("message", "start_engine test");

    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(expect.stringContaining("予算 2")),
    );
    expect(fetchEngineConfigs).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("refreshes stale cached costs before admitting a start", async () => {
    engineConfigCache.set("test", { ...config, threads: 1 });
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 2 }] });
    discover(2);
    socket.emit("message", "start_engine test");

    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(expect.stringContaining("追加 4")),
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not connect when the engine registry cannot be fetched", async () => {
    vi.mocked(fetchEngineConfigs).mockRejectedValue(new Error("Registry unavailable"));
    socket.emit("message", "start_engine test");

    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(expect.stringContaining("Registry unavailable")),
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not connect when the requested engine is absent from the registry", async () => {
    vi.mocked(fetchEngineConfigs).mockResolvedValue([]);
    socket.emit("message", "start_engine test");

    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(expect.stringContaining("エンジンを利用できません")),
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects unresolved Threads before connecting and asks for a manual cost", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    vi.mocked(fetchEngineConfigs).mockResolvedValue([{ ...config, threads: undefined }]);
    socket.emit("message", "start_engine test");
    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(expect.stringContaining("手動指定")),
    );
    expect(connect).not.toHaveBeenCalled();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("retains a single reservation across disconnect, reconnect and redundant starts", async () => {
    discover(4);
    socket.emit("message", "start_engine test");
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);

    socket.emit("close");
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    });
    session.attach(socket as unknown as Parameters<EngineSession["attach"]>[0]);
    socket.emit("message", "start_engine test");
    expect(fetchEngineConfigs).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    socket.emit("message", "stop_engine");
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it("releases the reservation if the engine connection fails", async () => {
    discover(4);
    socket.emit("message", "start_engine test");
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    const engineSocket = connect.mock.contexts[0] as net.Socket;
    engineSocket.emit("error", new Error("Connection refused"));
    engineSocket.destroy();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });

  it.each([undefined, ""])(
    "handles connected transport errors without authentication (token: %s)",
    async (token) => {
      vi.stubEnv("WRAPPER_ACCESS_TOKEN", token);
      discover(4);
      socket.emit("message", "start_engine test");
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
      const engineSocket = connect.mock.contexts[0] as net.Socket;
      const write = vi.spyOn(engineSocket, "write").mockReturnValue(true);
      try {
        engineSocket.emit("connect");
        expect(write).toHaveBeenCalledWith("run test\n");
        expect(write).toHaveBeenCalledWith("usi\n");
        engineSocket.emit("data", Buffer.from("usiok\nreadyok\n"));
        expect(session.internalSnapshot.state).toBe(EngineState.READY);
        expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
        socket.send.mockClear();

        expect(() => engineSocket.emit("error", new Error("Connection reset"))).not.toThrow();

        expect(socket.send).toHaveBeenCalledWith(
          expect.stringContaining("remote engine connection failed"),
        );
        expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
        expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
      } finally {
        engineSocket.destroy();
      }
    },
  );

  it("deduplicates pending discovery and does not reserve or connect after cancellation", async () => {
    const pending = Promise.withResolvers<EngineConfig[]>();
    vi.mocked(fetchEngineConfigs).mockReturnValue(pending.promise);
    resourceRegistry.update({ enabled: true, groups: [{ id: "g", name: "G", budget: 4 }] });
    socket.emit("message", "start_engine test");
    socket.emit("message", "start_engine test");
    socket.emit("message", "stop_engine");
    pending.resolve([config]);
    await new Promise(setImmediate);

    expect(fetchEngineConfigs).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
  });
});
