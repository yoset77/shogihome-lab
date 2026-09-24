import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Move } from "tsshogi";
import { EngineSession } from "@/server/engine/session";
import { EngineState } from "@/server/engine/types";
import { LanPlayer } from "@/renderer/players/lan_player";
import { HumanPlayer } from "@/renderer/players/human";
import { GameManager } from "@/renderer/store/game";
import { RecordManager } from "@/renderer/store/record";
import { Clock } from "@/renderer/store/clock";
import { defaultGameSettings } from "@/common/settings/game";
import { ES_HUMAN } from "@/common/uri";

vi.mock("@/renderer/ipc/api");
vi.mock("@/renderer/players/usi_events");
vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));

describe("takeback across the real relay", () => {
  let session: EngineSession;
  let stream: PassThrough;
  let writes: string[];
  let sockets: Transport[];
  let dropClient: boolean;
  let dropServer: boolean;
  let serverFrames: string[];

  class Transport {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    server = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: (data: string) => {
        serverFrames.push(data);
        if (!dropServer) queueMicrotask(() => this.onmessage?.({ data }));
      },
      terminate: () => this.close(),
    });
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
        session.attach(this.server as unknown as Parameters<EngineSession["attach"]>[0]);
      });
    }
    send(data: string) {
      if (!dropClient) queueMicrotask(() => this.server.emit("message", data, false));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.server.readyState = 3;
      this.server.emit("close");
      queueMicrotask(() => this.onclose?.({ code: 1006, reason: "test disconnect" }));
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sockets = [];
    writes = [];
    serverFrames = [];
    dropClient = false;
    dropServer = false;
    session = new EngineSession("integration");
    stream = new PassThrough();
    const internal = session as unknown as {
      currentEngineId: string;
      engineState: EngineState;
      engineHandle: unknown;
      setupEngineHandlers(stream: PassThrough): void;
      onEngineClose(): void;
    };
    internal.currentEngineId = "test";
    internal.engineState = EngineState.READY;
    internal.engineHandle = {
      write: (line: string) => writes.push(line),
      close: () => internal.onEngineClose(),
      removeAllListeners: () => {},
    };
    internal.setupEngineHandlers(stream);
    vi.stubGlobal("WebSocket", Transport);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function start(loseSearch = false) {
    const lan = new LanPlayer("takeback", "test", "Test");
    const human = new HumanPlayer();
    const records = new RecordManager();
    const game = new GameManager(records, new Clock(), new Clock());
    const error = vi.fn();
    game.on("error", error);
    await lan.launch();
    expect(lan.supportsTakeback).toBe(true);
    await game.start(
      {
        ...defaultGameSettings(),
        enableComment: false,
        black: { uri: ES_HUMAN, name: "Human" },
        white: { uri: "lan-engine:test", name: "AI" },
      },
      { build: async (p) => (p.uri === ES_HUMAN ? human : lan) },
    );
    await vi.advanceTimersByTimeAsync(0);
    const move = () => human.doMove(records.record.position.createMoveByUSI("7g7f") as Move);
    dropClient = loseSearch;
    move();
    await vi.advanceTimersByTimeAsync(0);
    return { game, lan, records, error, move };
  }

  it("recovers a lost cancellation acknowledgement and rejects old results after the same move", async () => {
    const { game, lan, records, error, move } = await start();
    dropServer = true;
    const pending = game.takeback();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toContain("stop\n");
    stream.write("bestmove 3c3d\n");
    const oldOutput = serverFrames.findLast((frame) => frame.includes("bestmove"))!;
    expect(game.isTakingBack).toBe(true);
    dropServer = false;
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(records.record.current.ply).toBe(0);
    move();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].onmessage?.({ data: oldOutput });
    await vi.advanceTimersByTimeAsync(0);
    expect(records.record.current.ply).toBe(1);
    stream.write("bestmove 8c8d\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(records.record.current.ply).toBe(2);
    expect(error).not.toHaveBeenCalled();
    expect(writes.filter((line) => line.startsWith("go "))).toHaveLength(2);
    await lan.close();
  });

  it("retries a cancellation whose delivery was unknown without replaying the cancelled go", async () => {
    const { game, lan, records, error } = await start();
    dropClient = true;
    const pending = game.takeback();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).not.toContain("stop\n");
    sockets[0].close();
    dropClient = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes.filter((line) => line === "stop\n")).toHaveLength(1);
    stream.write("bestmove 3c3d\n");
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(records.record.current.ply).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(writes.filter((line) => line.startsWith("go "))).toHaveLength(1);
    await lan.close();
  });

  it("discards an undelivered search instead of flushing it on reconnect", async () => {
    const { game, lan, records } = await start(true);
    const pending = game.takeback();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].close();
    dropClient = false;
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(records.record.current.ply).toBe(0);
    expect(writes.some((line) => line.startsWith("go "))).toBe(false);
    await lan.close();
  });

  it("interrupts with the original moves when the server session is replaced", async () => {
    const { game, lan, records, error } = await start();
    dropClient = true;
    const pending = game.takeback();
    sockets[0].close();
    session = new EngineSession("integration");
    dropClient = false;
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(game.isActive).toBe(false);
    expect(records.record.current.prev?.ply).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    await lan.close();
  });

  it("times out a nonresponsive engine and remains interruptible", async () => {
    const { game, lan, records, error } = await start();
    const pending = game.takeback();
    await vi.advanceTimersByTimeAsync(10001);
    await pending;
    expect(game.isActive).toBe(false);
    expect(records.record.current.prev?.ply).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    await lan.close();
  });
});
