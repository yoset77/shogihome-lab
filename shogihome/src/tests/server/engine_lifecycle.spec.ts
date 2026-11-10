// @vitest-environment node
import { EventEmitter } from "node:events";
import net from "node:net";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { decodeServerRelayMessage } from "@/common/engine/relay_protocol";
import { t } from "@/common/i18n";
import {
  ANALYSIS_DB_MIN_DEPTH,
  ENGINE_STOP_TIMEOUT_MS,
  RELAY_READY_TIMEOUT_MS,
} from "@/server/config";
import { saveAnalysisResults } from "@/server/database/sqlite";
import { authenticateSocket } from "@/server/engine/auth";
import { fetchEngineConfigs } from "@/server/engine/list";
import { resourceRegistry } from "@/server/engine/resources";
import { EngineSession } from "@/server/engine/session";
import { EngineState } from "@/server/engine/types";

vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));
vi.mock("@/server/engine/auth", () => ({ authenticateSocket: vi.fn() }));
vi.mock("@/server/engine/list", async (original) => ({
  ...(await original<typeof import("@/server/engine/list")>()),
  fetchEngineConfigs: vi.fn(),
}));

describe("engine transport lifetimes", () => {
  function setup() {
    const ws = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN as number,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    });
    const session = new EngineSession("lifecycle");
    session.attach(ws as unknown as WebSocket);
    const connect = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
      this: net.Socket,
    ) {
      return this;
    });
    const readers = vi.spyOn(readline, "createInterface");
    const sockets: net.Socket[] = [];
    const start = async () => {
      const previousConnections = connect.mock.calls.length;
      ws.emit("message", "start_engine test");
      await Promise.resolve();
      expect(connect).toHaveBeenCalledTimes(previousConnections + 1);
      const socket = connect.mock.contexts.at(-1) as net.Socket;
      sockets.push(socket);
      const write = vi.spyOn(socket, "write").mockReturnValue(true);
      const end = vi.spyOn(socket, "end").mockReturnValue(socket);
      const destroy = vi.spyOn(socket, "destroy");
      return { socket, write, end, destroy };
    };
    const ready = async () => {
      const engine = await start();
      engine.socket.emit("connect");
      engine.socket.emit("data", Buffer.from("usiok\nreadyok\n"));
      expect(session.internalSnapshot.state).toBe(EngineState.READY);
      return engine;
    };
    const messages = () =>
      ws.send.mock.calls.map(([frame]) => {
        const decoded = decodeServerRelayMessage(frame);
        if (!decoded.ok) throw new Error(decoded.error);
        return decoded.value;
      });
    return { session, ws, start, ready, readers, messages, sockets };
  }

  let fixture: ReturnType<typeof setup>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("WRAPPER_ACCESS_TOKEN", "");
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 4 }]);
    vi.mocked(fetchEngineConfigs).mockResolvedValue([
      { id: "test", name: "Test", threads: 4, resource: { groupId: "g" } },
    ]);
    fixture = setup();
  });

  afterEach(async () => {
    fixture.ws.emit("message", "stop_engine");
    for (const socket of fixture.sockets) {
      socket.destroy();
      socket.emit("close");
    }
    await Promise.resolve();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    resourceRegistry.resetForTest();
    vi.useRealTimers();
  });

  it("settles a connection closed before connect and permits a new start", async () => {
    const { session, start, ready, messages } = fixture;
    const first = await start();
    const instanceId = session.internalSnapshot.instanceId;
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);

    first.socket.emit("close");

    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(session.internalSnapshot.instanceId).not.toBe(instanceId);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(messages().filter((message) => message.type === "notice")).toEqual([
      { type: "notice", notice: "engineStopped", delay: 0 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    const second = await ready();
    expect(second.socket).not.toBe(first.socket);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
  });

  it("also settles an engine started under a discovery session ID", () => {
    const session = new EngineSession("discovery-lifecycle", undefined, "internal");
    session.startInternalEngine({ id: "test", name: "Test" });
    const socket = vi.mocked(net.Socket.prototype.connect).mock.contexts.at(-1) as net.Socket;
    fixture.sockets.push(socket);
    socket.emit("close");
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connecting", "authenticating"])(
    "immediately cancels connection deadlines on termination while %s",
    async (stage) => {
      const { session, ws, start } = fixture;
      if (stage === "authenticating") {
        vi.stubEnv("WRAPPER_ACCESS_TOKEN", "token");
        vi.mocked(authenticateSocket).mockReturnValue(new Promise(() => {}));
      }
      const engine = await start();
      if (stage === "authenticating") engine.socket.emit("connect");

      ws.emit("message", "stop_engine");

      expect(engine.destroy).toHaveBeenCalledOnce();
      expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(engine.write).not.toHaveBeenCalled();
    },
  );

  it("destroys a failed transport before releasing its reservation and finalizes only once", async () => {
    const { session, ws, ready, messages } = fixture;
    const engine = await ready();
    const instanceId = session.internalSnapshot.instanceId;
    engine.destroy.mockImplementationOnce(() => {
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
      return engine.socket;
    });
    ws.send.mockClear();

    engine.socket.emit("error", new Error("Connection reset"));
    engine.socket.emit("close");

    expect(engine.destroy).toHaveBeenCalledOnce();
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(session.internalSnapshot.instanceId).not.toBe(instanceId);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(messages().filter((message) => message.type === "error")).toHaveLength(1);
    expect(messages().filter((message) => message.type === "notice")).toEqual([
      { type: "notice", notice: "engineStopped", delay: 0 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    engine.destroy.mockRestore();
  });

  it.each(["connecting", "authenticating", "ready"])(
    "cleans up socket errors without exposing their details while %s",
    async (stage) => {
      const { session, start, ready, messages } = fixture;
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const error = new Error("connect ECONNREFUSED 192.0.2.25:53556");
      if (stage === "authenticating") {
        vi.stubEnv("WRAPPER_ACCESS_TOKEN", "token");
        vi.mocked(authenticateSocket).mockReturnValue(new Promise(() => {}));
      }
      const engine = stage === "ready" ? await ready() : await start();
      if (stage === "authenticating") engine.socket.emit("connect");

      engine.socket.emit("error", error);

      expect(log).toHaveBeenCalledWith(expect.any(String), error);
      expect(messages().filter((message) => message.type === "error")).toEqual([
        { type: "error", message: `error: ${t.remoteEngineConnectionFailed}`, delay: 0 },
      ]);
      expect(engine.destroy).toHaveBeenCalledOnce();
      expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cleans up failed authentication without exposing its error", async () => {
    const { session, start, messages } = fixture;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Private authentication details");
    vi.stubEnv("WRAPPER_ACCESS_TOKEN", "token");
    vi.mocked(authenticateSocket).mockRejectedValue(error);
    const engine = await start();

    engine.socket.emit("connect");
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith("Authentication failed:", error);
    expect(messages().filter((message) => message.type === "error")).toEqual([
      { type: "error", message: `error: ${t.remoteEngineConnectionFailed}`, delay: 0 },
    ]);
    expect(engine.destroy).toHaveBeenCalledOnce();
    expect(engine.write).not.toHaveBeenCalled();
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connecting", "ready"])(
    "ignores old transport callbacks while its successor is %s",
    async (stage) => {
      const { session, ws, start, ready } = fixture;
      const first = await start();
      const oldConnect = first.socket.listeners("connect");
      const oldErrors = first.socket.listeners("error");
      const oldClose = first.socket.listeners("close");
      first.socket.emit("error", new Error("Connection refused"));
      first.socket.destroy();
      const second = stage === "ready" ? await ready() : await start();
      const snapshot = session.internalSnapshot;
      ws.send.mockClear();

      for (const listener of oldConnect) listener();
      for (const listener of oldErrors) listener(new Error("Late error"));
      for (const listener of oldClose) listener(false);

      expect(first.write).not.toHaveBeenCalled();
      expect(session.internalSnapshot).toEqual(snapshot);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
      expect(ws.send).not.toHaveBeenCalled();
      expect(second.destroy).not.toHaveBeenCalled();
    },
  );

  it.each(["resolve", "reject"])(
    "ignores authentication that settles with %s after another engine starts",
    async (outcome) => {
      const { session, ws, start, ready } = fixture;
      vi.stubEnv("WRAPPER_ACCESS_TOKEN", "token");
      const auth = Promise.withResolvers<readline.Interface>();
      vi.mocked(authenticateSocket).mockReturnValue(auth.promise);
      const first = await start();
      first.socket.emit("connect");
      first.socket.emit("close");
      vi.stubEnv("WRAPPER_ACCESS_TOKEN", "");
      await ready();
      const snapshot = session.internalSnapshot;
      ws.send.mockClear();
      const input = new PassThrough();
      const reader = readline.createInterface({ input });
      const close = vi.spyOn(reader, "close");

      if (outcome === "resolve") auth.resolve(reader);
      else auth.reject(new Error("Late authentication failure"));
      await Promise.resolve();

      expect(first.write).not.toHaveBeenCalled();
      expect(session.internalSnapshot).toEqual(snapshot);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
      expect(ws.send).not.toHaveBeenCalled();
      if (outcome === "resolve") expect(close).toHaveBeenCalledOnce();
      reader.close();
      input.end();
    },
  );

  it("transfers an authenticated reader to the running engine and closes it on exit", async () => {
    const { session, ws, start } = fixture;
    vi.stubEnv("WRAPPER_ACCESS_TOKEN", "token");
    const engine = await start();
    const reader = readline.createInterface({ input: engine.socket });
    const close = vi.spyOn(reader, "close");
    vi.mocked(authenticateSocket).mockResolvedValue(reader);

    engine.socket.emit("connect");
    await Promise.resolve();
    engine.socket.emit("data", Buffer.from("usiok\nreadyok\n"));

    expect(engine.write.mock.calls.map(([line]) => line)).toEqual([
      "run test\n",
      "usi\n",
      "isready\n",
    ]);
    expect(session.internalSnapshot.state).toBe(EngineState.READY);
    expect(close).not.toHaveBeenCalled();
    ws.emit("message", "stop_engine");
    expect(close).not.toHaveBeenCalled();
    engine.socket.emit("close");
    expect(close).toHaveBeenCalledOnce();
    expect(reader.listenerCount("line")).toBe(0);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys and settles a timed-out connection before allowing another start", async () => {
    const { session, ready, start, messages } = fixture;
    const first = await start();
    vi.advanceTimersByTime(4999);
    expect(first.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(messages().filter((message) => message.type === "error")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await ready();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
  });

  it("settles a synchronous connect failure without leaving the session starting", async () => {
    const { session, start, ready, messages } = fixture;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Private connection setup details");
    vi.mocked(net.Socket.prototype.connect).mockImplementationOnce(() => {
      throw error;
    });
    const first = await start();
    expect(log).toHaveBeenCalledWith("Failed to connect to remote engine:", error);
    expect(messages().filter((message) => message.type === "error")).toEqual([
      { type: "error", message: `error: ${t.remoteEngineConnectionFailed}`, delay: 0 },
    ]);
    expect(first.socket.destroyed).toBe(true);
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await ready();
  });

  it.each([false, true])(
    "cleans up a failed run command without exposing its error (authenticated: %s)",
    async (authenticated) => {
      const { session, start, messages } = fixture;
      const engine = await start();
      const reader = authenticated ? readline.createInterface({ input: engine.socket }) : undefined;
      const close = reader ? vi.spyOn(reader, "close") : undefined;
      if (reader) {
        vi.stubEnv("WRAPPER_ACCESS_TOKEN", "token");
        vi.mocked(authenticateSocket).mockResolvedValue(reader);
      }
      engine.write.mockImplementationOnce(() => {
        throw new Error("Private setup details");
      });
      engine.socket.emit("connect");
      await Promise.resolve();
      expect(engine.destroy).toHaveBeenCalledOnce();
      expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
      expect(messages().filter((message) => message.type === "error")).toEqual([
        { type: "error", message: `error: ${t.remoteEngineConnectionFailed}`, delay: 0 },
      ]);
      if (authenticated) expect(close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["readiness", "stop"])(
    "ignores a captured %s timeout without clearing the next engine's deadline",
    async (phase) => {
      const { session, ws, ready } = fixture;
      const timeouts = vi.spyOn(globalThis, "setTimeout");
      const beginWait = () => {
        if (phase === "stop") {
          for (const command of ["position startpos", "go infinite", "stop"])
            ws.emit("message", command);
        } else {
          for (const command of ["usinewgame", "gameover draw", "usinewgame"])
            ws.emit("message", command);
        }
      };
      const first = await ready();
      beginWait();
      const oldTimeout = timeouts.mock.calls.at(-1)![0] as () => void;
      first.socket.emit("error", new Error("Connection reset"));
      const second = await ready();
      beginWait();
      const snapshot = session.internalSnapshot;
      ws.send.mockClear();

      oldTimeout();

      expect(session.internalSnapshot).toEqual(snapshot);
      expect(ws.send).not.toHaveBeenCalled();
      expect(second.end).not.toHaveBeenCalled();
      expect(second.destroy).not.toHaveBeenCalled();
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
      const deadline = phase === "stop" ? ENGINE_STOP_TIMEOUT_MS : RELAY_READY_TIMEOUT_MS;
      vi.advanceTimersByTime(deadline - 1);
      expect(second.end).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(second.end).toHaveBeenCalledOnce();
      expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);
    },
  );

  it.each([
    "info depth 10 score cp 20 pv 7g7f",
    "bestmove 7g7f",
    "bestmove invalid",
    "WRAPPER_ERROR: Relay failed",
  ])("ignores old output after another engine starts: %s", async (line) => {
    const { session, ws, ready, readers } = fixture;
    const first = await ready();
    const reader = readers.mock.results.at(-1)!.value as readline.Interface;
    const oldLines = reader.listeners("line");
    first.socket.emit("error", new Error("Connection reset"));
    await ready();
    ws.emit("message", "position startpos moves 7g7f");
    ws.emit("message", "go infinite");
    const snapshot = session.internalSnapshot;
    ws.send.mockClear();

    for (const listener of oldLines) listener(line);

    expect(reader.listenerCount("line")).toBe(0);
    expect(session.internalSnapshot).toEqual(snapshot);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("bounds both shutdown phases without saving partial analysis or releasing resources early", async () => {
    const { session, ws, ready } = fixture;
    const engine = await ready();
    ws.emit("message", "position startpos");
    ws.emit("message", "go infinite");
    engine.socket.emit(
      "data",
      Buffer.from(`info depth ${ANALYSIS_DB_MIN_DEPTH} score cp 20 pv 7g7f\n`),
    );
    ws.emit("message", "stop_engine");
    ws.emit("message", "stop_engine");
    ws.readyState = WebSocket.CLOSED;
    ws.emit("close");
    expect(engine.write.mock.calls.filter(([line]) => line === "stop\n")).toHaveLength(1);

    vi.advanceTimersByTime(ENGINE_STOP_TIMEOUT_MS);
    expect(engine.end).toHaveBeenCalledOnce();
    expect(engine.destroy).not.toHaveBeenCalled();
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
    expect(session.internalSnapshot.state).toBe(EngineState.TERMINATING);

    vi.advanceTimersByTime(ENGINE_STOP_TIMEOUT_MS - 1);
    expect(engine.destroy).not.toHaveBeenCalled();
    engine.destroy.mockImplementationOnce((error) => {
      expect(resourceRegistry.groupSnapshot()[0].used).toBe(4);
      return net.Socket.prototype.destroy.call(engine.socket, error);
    });
    vi.advanceTimersByTime(1);
    expect(engine.destroy).toHaveBeenCalledOnce();
    expect(engine.socket.destroyed).toBe(true);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(saveAnalysisResults).not.toHaveBeenCalled();
    engine.socket.emit("data", Buffer.from("bestmove 7g7f\n"));
    engine.socket.emit("close");
    expect(saveAnalysisResults).not.toHaveBeenCalled();
    expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
    expect(vi.getTimerCount()).toBe(0);
  });
});
