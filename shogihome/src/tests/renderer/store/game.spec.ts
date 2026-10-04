import { Record, Move, importKIF } from "tsshogi";
import { reactive, markRaw } from "vue";
import { GameManager } from "@/renderer/store/game";
import { RecordManager } from "@/renderer/store/record";
import { GameClockDisplay } from "@/renderer/store/game_clock";
import { GameSessionManager } from "@/server/game/manager";
import { HttpError } from "@/server/errors";
import { ApiResponseError } from "@/renderer/api/client";
import type { GameSessionsClient } from "@/renderer/api/game_sessions";
import {
  decodeGameClientFrame,
  decodeGameConnection,
  type GameSessionRequest,
  type GameCommand,
  type GameFrame,
} from "@/common/game/protocol";
import { SearchInfoSenderType } from "@/common/record/types";
import { defaultGameSettings } from "@/common/settings/game";
import { loadRecordForWebApp } from "@/renderer/store/webapp";
import { fakeGamePlayer } from "@/tests/server/helpers/game";
import { useToastStore } from "@/renderer/store/toast";
import { t } from "@/common/i18n";
import api from "@/renderer/ipc/api";

vi.mock("@/server/file/history", () => ({
  saveBackup: vi.fn().mockResolvedValue(undefined),
  addHistory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/renderer/ipc/api", () => ({
  isNative: () => false,
  isMobileWebApp: () => false,
  default: { log: vi.fn(), saveRecordFileBackup: vi.fn().mockResolvedValue(undefined) },
}));

function storedReference(): string | null {
  const key = Object.keys(localStorage).find((key) => key.startsWith("shogihome-game-session:"));
  return localStorage.getItem(key ?? "shogihome-game-session");
}

function setup() {
  const fake = fakeGamePlayer();
  const saveRecord = vi.fn(async () => {
    throw new Error("Disk unavailable");
  });
  const server = new GameSessionManager({
    playerBuilder: fake.builder,
    saveRecord,
    now: () => Date.now(),
  });
  const asHttp = async <T>(call: () => T | Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpError) throw new ApiResponseError(error.status, error.message);
      throw error;
    }
  };
  let request: GameSessionRequest | undefined;
  const client = {
    capabilities: vi.fn(async () => server.capabilities()),
    create: vi.fn(async (input: GameSessionRequest) => {
      const session = await asHttp(() => server.create(input));
      request = input;
      return session.snapshot();
    }),
    byRequest: vi.fn(async (id: string) => asHttp(() => server.byRequest(id).snapshot())),
    snapshot: vi.fn(async (id: string) => asHttp(() => server.get(id).snapshot())),
    command: vi.fn(async (id: string, command: GameCommand) =>
      asHttp(() => server.get(id).command(command)),
    ),
  } satisfies GameSessionsClient;
  const sockets: FakeSocket[] = [];
  let socketDelayMs = 0;
  let dropNextFrames = false;
  class FakeSocket {
    readyState = 0;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    connection?: { disconnect(): void; heartbeat(): void };
    constructor(url: string) {
      sockets.push(this);
      const dropFrames = dropNextFrames;
      dropNextFrames = false;
      const connect = () => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        const parsed = new URL(url);
        const binding = decodeGameConnection({
          connectionId: parsed.searchParams.get("connectionId"),
          controllerEpoch: Number(parsed.searchParams.get("controllerEpoch")),
        });
        if (!binding.ok) throw new Error(binding.error);
        try {
          this.connection = server.byRequest(request!.requestId).connect(
            parsed.searchParams.get("controllerId")!,
            (frame: GameFrame) => {
              queueMicrotask(() => {
                if (this.readyState === 1 && !dropFrames)
                  this.onmessage?.({ data: JSON.stringify(frame) });
              });
            },
            (code) => this.close(code),
            binding.value,
          );
        } catch (error) {
          this.close(error instanceof HttpError && error.status === 409 ? 4001 : 4004);
        }
      };
      if (socketDelayMs) setTimeout(connect, socketDelayMs);
      else queueMicrotask(connect);
    }
    send(data: string): void {
      const decoded = decodeGameClientFrame(JSON.parse(data));
      if (!decoded.ok) throw new Error(decoded.error);
      if (decoded.value.type === "heartbeat") this.connection?.heartbeat();
      else server.byRequest(request!.requestId).annotate(decoded.value.value);
    }
    close(code = 1006): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.connection?.disconnect();
      queueMicrotask(() => this.onclose?.({ code }));
    }
  }
  const records = new RecordManager();
  const socketFactory = (url: string) => markRaw(new FakeSocket(url)) as unknown as WebSocket;
  const game = reactive(
    new GameManager(
      records,
      new GameClockDisplay(() => Date.now()),
      new GameClockDisplay(() => Date.now()),
      client,
      socketFactory,
    ),
  );
  const error = vi.fn();
  const end = vi.fn();
  const beat = vi.fn();
  game.on("error", error).on("gameEnd", end).on("pieceBeat", beat);
  const settings = {
    ...defaultGameSettings(),
    enableAutoSave: false,
    enableComment: false,
    timeLimit: { timeSeconds: 3600, byoyomi: 10, increment: 0 },
  };
  return {
    game,
    records,
    server,
    client,
    sockets,
    delayConnections: (ms: number) => {
      socketDelayMs = ms;
    },
    dropNextConnectionFrames: () => {
      dropNextFrames = true;
    },
    socketFactory,
    error,
    end,
    beat,
    settings,
    saveRecord,
    ...fake,
    session: () => server.byRequest(request!.requestId),
    reload: () =>
      new GameManager(
        new RecordManager(loadRecordForWebApp()!),
        new GameClockDisplay(),
        new GameClockDisplay(),
        client,
        socketFactory,
      ),
  };
}

describe("game session client", () => {
  const fixtures: ReturnType<typeof setup>[] = [];
  const extraClients: GameManager[] = [];
  const fixture = () => {
    const value = setup();
    fixtures.push(value);
    return value;
  };
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(api.saveRecordFileBackup).mockReset().mockResolvedValue(undefined);
    useToastStore().clear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const game of extraClients.splice(0)) game.dispose();
    for (const value of fixtures.splice(0)) {
      value.game.dispose();
      const close = value.server.close();
      await vi.advanceTimersByTimeAsync(10);
      await close;
    }
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  async function start(value: ReturnType<typeof setup>, ai = false) {
    if (ai) value.settings.white = { uri: "lan-engine:test", name: "AI" };
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.error.mock.calls).toEqual([]);
    expect(value.game.canMove).toBe(true);
  }

  it("preserves the active game's recovery reference when a stale tab tries to start", async () => {
    const value = fixture();
    const records = new RecordManager();
    const stale = new GameManager(
      records,
      new GameClockDisplay(),
      new GameClockDisplay(),
      value.client,
      value.socketFactory,
    );
    extraClients.push(stale);
    await start(value);
    const reference = storedReference();
    expect(reference).not.toBeNull();
    await expect(stale.start(value.settings)).rejects.toThrow();
    expect(storedReference()).toBe(reference);
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(records.analysisLocked).toBe(false);
    value.game.dispose();
    const recovered = value.reload();
    extraClients.push(recovered);
    await recovered.resume(async () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered.canMove).toBe(true);
  });

  it("rechecks shared recovery state after asynchronous startup preparation", async () => {
    const value = fixture();
    const stale = new GameManager(
      new RecordManager(),
      new GameClockDisplay(),
      new GameClockDisplay(),
      value.client,
      value.socketFactory,
    );
    extraClients.push(stale);
    let complete!: () => void;
    value.client.capabilities.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return value.server.capabilities();
    });
    const starting = stale.start(value.settings);
    await start(value);
    const reference = storedReference();
    complete();
    await expect(starting).rejects.toThrow();
    expect(storedReference()).toBe(reference);
    expect(value.client.create).toHaveBeenCalledOnce();
  });

  it("backs up the unsaved document before creating a game that replaces it", async () => {
    const value = fixture();
    value.records.appendMove({ move: value.records.record.position.createMoveByUSI("2g2f")! });
    value.records.updateComment("Unsaved analysis");
    let complete!: () => void;
    vi.mocked(api.saveRecordFileBackup).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const starting = value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveRecordFileBackup).toHaveBeenCalledOnce();
    expect(value.client.create).not.toHaveBeenCalled();
    expect(value.records.record.current.comment).toBe("Unsaved analysis");
    complete();
    await starting;
    await vi.advanceTimersByTimeAsync(1);
    const backup = importKIF(vi.mocked(api.saveRecordFileBackup).mock.calls[0][0]) as Record;
    backup.goto(backup.length);
    expect(backup.current.move).toBeInstanceOf(Move);
    expect((backup.current.move as Move).usi).toBe("2g2f");
    expect(backup.current.comment.trim()).toBe("Unsaved analysis");
    expect(value.records.record.current.ply).toBe(0);
  });

  it("preserves the document and releases its lock when startup backup fails", async () => {
    const value = fixture();
    value.records.updateComment("Unsaved analysis");
    vi.mocked(api.saveRecordFileBackup).mockRejectedValueOnce(new Error("Backup failed"));
    await expect(value.game.start(value.settings)).rejects.toThrow("Backup failed");
    expect(value.client.create).not.toHaveBeenCalled();
    expect(value.records.record.current.comment).toBe("Unsaved analysis");
    expect(value.records.analysisLocked).toBe(false);
    expect(storedReference()).toBeNull();
  });

  it("does not let a disconnected old tab automatically reclaim a replacement controller", async () => {
    const value = fixture();
    await start(value);
    value.sockets[0].close();
    await vi.advanceTimersByTimeAsync(0);
    const recovered = value.reload();
    extraClients.push(recovered);
    await recovered.resume(async () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered.canMove).toBe(true);
    const reference = storedReference();
    await vi.advanceTimersByTimeAsync(1100);
    expect(recovered.canMove).toBe(true);
    expect(value.game.isActive).toBe(false);
    expect(value.records.analysisLocked).toBe(false);
    expect(storedReference()).toBe(reference);
    expect(value.error).toHaveBeenCalledOnce();
  });

  it("does not delete another game's linkage when its own creation is rejected", async () => {
    const value = fixture();
    const other = JSON.stringify({
      requestId: "other-request",
      serverInstanceId: value.server.serverInstanceId,
      controllerId: "other-controller",
      sessionId: "other-session",
      content: "Other game",
      pending: [],
    });
    value.client.create.mockImplementationOnce(async () => {
      localStorage.setItem("shogihome-game-session:other-request", other);
      throw new ApiResponseError(503, "Another game is running");
    });
    await expect(value.game.start(value.settings)).rejects.toMatchObject({ status: 503 });
    expect(storedReference()).toBe(other);
    expect(value.game.hasRetainedSession).toBe(true);
    expect(value.records.analysisLocked).toBe(false);
  });

  it("migrates legacy recovery linkage without creating another game", async () => {
    const value = fixture();
    await start(value);
    value.game.dispose();
    const reference = storedReference()!;
    const key = Object.keys(localStorage).find((key) => key.startsWith("shogihome-game-session:"))!;
    localStorage.setItem("shogihome-game-session", reference);
    localStorage.removeItem(key);
    const recovered = value.reload();
    extraClients.push(recovered);
    await recovered.resume(async () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered.canMove).toBe(true);
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(localStorage.getItem("shogihome-game-session")).toBeNull();
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it("skips an unconfirmed rejected creation when recovering a concurrently delivered request", async () => {
    const value = fixture();
    const original = value.client.create.getMockImplementation()!;
    value.client.create.mockImplementationOnce(async (request) => {
      await original(request);
      throw new TypeError("Response lost");
    });
    await value.game.start(value.settings);
    const reference = storedReference()!;
    const key = Object.keys(localStorage).find((key) => key.startsWith("shogihome-game-session:"))!;
    localStorage.removeItem(key);
    localStorage.setItem(
      "shogihome-game-session:rejected",
      JSON.stringify({
        ...JSON.parse(reference),
        requestId: "rejected",
      }),
    );
    localStorage.setItem(key, reference);
    value.game.dispose();
    const recovered = value.reload();
    extraClients.push(recovered);
    const error = vi.fn();
    recovered.on("error", error);
    await recovered.resume(async () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered.canMove).toBe(true);
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(localStorage.getItem("shogihome-game-session:rejected")).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("recovers a lost initial socket snapshot using the same connection identity", async () => {
    const value = fixture();
    value.dropNextConnectionFrames();
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.game.canMove).toBe(false);
    value.sockets[0].close();
    await vi.advanceTimersByTimeAsync(1100);
    expect(value.game.canMove).toBe(true);
    expect(value.error).not.toHaveBeenCalled();
  });

  it("fences a delayed retry handshake after another tab takes control", async () => {
    const value = fixture();
    await start(value);
    value.delayConnections(50);
    value.sockets[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    value.delayConnections(0);
    const recovered = value.reload();
    extraClients.push(recovered);
    await recovered.resume(async () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered.canMove).toBe(true);
    const reference = storedReference();
    await vi.advanceTimersByTimeAsync(50);
    expect(recovered.canMove).toBe(true);
    expect(value.game.isActive).toBe(false);
    expect(storedReference()).toBe(reference);
    expect(value.error).toHaveBeenCalledOnce();
  });

  it("uses server-confirmed moves, locks edits and navigates only after game completion", async () => {
    const value = fixture();
    await start(value);
    const { game, records, client } = value;
    expect(records.analysisLocked).toBe(true);
    let complete!: () => void;
    const original = client.command.getMockImplementation()!;
    client.command.mockImplementationOnce(async (id, command) => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return original(id, command);
    });
    const move = game.move(records.record.position.createMoveByUSI("7g7f")!);
    expect(records.record.current.ply).toBe(0);
    expect(game.canMove).toBe(false);
    complete();
    await move;
    await vi.advanceTimersByTimeAsync(0);
    expect(records.record.current.ply).toBe(1);
    records.goBack();
    expect(records.record.current.ply).toBe(1);
    const jump = vi.spyOn(records.record as Record, "jumpToBookmark");
    records.jumpToBookmark("bookmark");
    expect(jump).not.toHaveBeenCalled();
    await game.resign();
    await vi.advanceTimersByTimeAsync(0);
    expect(game.isActive).toBe(false);
    expect(records.analysisLocked).toBe(false);
    expect(value.end).toHaveBeenCalledOnce();
    expect(storedReference()).toBeNull();
  });

  it("recovers a delivered move whose HTTP response was lost without playing it twice", async () => {
    const value = fixture();
    await start(value);
    const original = value.client.command.getMockImplementation()!;
    value.client.command.mockImplementationOnce(async (id, command) => {
      await original(id, command);
      throw new TypeError("Response lost");
    });
    await value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.records.record.current.ply).toBe(1);
    expect(value.game.canMove).toBe(true);
    const moves = value.client.command.mock.calls.filter(
      ([, command]) => command.action === "move",
    );
    expect(moves).toHaveLength(2);
    expect(moves[0][1].requestId).toBe(moves[1][1].requestId);
    expect(value.beat.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("notifies once per outage and only announces recovery after synchronization", async () => {
    const value = fixture();
    await start(value);
    expect(useToastStore().toasts).toHaveLength(0);
    value.sockets[0].close();
    await vi.advanceTimersByTimeAsync(0);
    expect(useToastStore().toasts).toMatchObject([
      { type: "warning", message: t.connectionLostRetrying, count: 1 },
    ]);
    value.client.snapshot.mockRejectedValueOnce(new TypeError("offline"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(useToastStore().toasts).toMatchObject([{ type: "warning", count: 1 }]);
    value.delayConnections(20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useToastStore().toasts[0].type).toBe("warning");
    await vi.advanceTimersByTimeAsync(20);
    expect(value.game.canMove).toBe(true);
    expect(useToastStore().toasts).toMatchObject([
      { type: "success", message: t.reconnected, count: 1 },
    ]);
    value.game.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(useToastStore().toasts[0].type).toBe("success");
  });

  it("retains an interrupt requested while creation recovery has not found the session yet", async () => {
    const value = fixture();
    const original = value.client.create.getMockImplementation()!;
    value.client.create.mockImplementationOnce(async (request) => {
      await original(request);
      throw new TypeError("Response lost");
    });
    await value.game.start(value.settings);
    value.game.stop();
    expect(JSON.parse(storedReference()!).stopRequested).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(value.game.isActive).toBe(false);
    expect(value.session().snapshot().state).toBe("completed");
    expect(value.client.create).toHaveBeenCalledOnce();
  });

  it("honors HTTP 429 backoff even when an interrupt is requested", async () => {
    const value = fixture();
    await start(value);
    value.client.snapshot.mockRejectedValueOnce(new ApiResponseError(429, "Limited", 30_000));
    value.sockets[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    const calls = value.client.snapshot.mock.calls.length;
    value.game.stop();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(value.client.snapshot).toHaveBeenCalledTimes(calls);
    expect(value.game.isActive).toBe(true);
    await vi.advanceTimersByTimeAsync(101);
    expect(value.game.isActive).toBe(false);
  });

  it("recovers through reload without replaying old move sounds", async () => {
    const value = fixture();
    await start(value, true);
    await value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
    value.game.dispose();
    value.searches[0].handler.onMove(value.records.record.position.createMoveByUSI("3c3d") as Move);
    const recovered = value.reload();
    const beat = vi.fn();
    recovered.on("pieceBeat", beat);
    const confirm = vi.fn(async () => true);
    await recovered.resume(confirm);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered.status?.record.nodes).toHaveLength(3);
    expect(recovered.canMove).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(beat).not.toHaveBeenCalled();
    recovered.dispose();
  });

  it("does not replace another unsaved record when recovery is declined", async () => {
    const value = fixture();
    await start(value);
    value.game.dispose();
    const other = Record.newByUSI("position startpos moves 2g2f") as Record;
    const records = new RecordManager(other);
    const recovered = new GameManager(
      records,
      new GameClockDisplay(),
      new GameClockDisplay(),
      value.client,
      value.socketFactory,
    );
    const confirm = vi.fn(async () => false);
    expect(await recovered.resume(confirm)).toBe(false);
    expect(records.record.usi).toBe("position startpos moves 2g2f");
    expect(records.analysisLocked).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    recovered.dispose();
  });

  it("never creates a replacement game after the server instance changes", async () => {
    const value = fixture();
    await start(value);
    value.game.dispose();
    value.client.capabilities.mockResolvedValue({
      ...value.server.capabilities(),
      serverInstanceId: "00000000-0000-0000-0000-000000000000",
    });
    const recovered = value.reload();
    const error = vi.fn();
    recovered.on("error", error);
    await recovered.resume(async () => true);
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(recovered.isActive).toBe(false);
    expect(error).toHaveBeenCalledOnce();
    expect(storedReference()).toBeNull();
    recovered.dispose();
  });

  it("requires durable linkage before POST and does not leave an edit lock when storage fails", async () => {
    const value = fixture();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    await expect(value.game.start(value.settings)).rejects.toThrow("Storage full");
    expect(value.client.create).not.toHaveBeenCalled();
    expect(value.records.analysisLocked).toBe(false);
  });

  it("does not clear completion linkage before the final browser record is stored", async () => {
    const value = fixture();
    await start(value);
    const original = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      data,
    ) {
      if (key === "webapp:jkf") throw new Error("Record storage failed");
      return original.call(this, key, data);
    });
    await expect(value.game.resign()).rejects.toThrow("Record storage failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(storedReference()).not.toBeNull();
    expect(value.game.isActive).toBe(true);
    storage.mockRestore();
    await vi.advanceTimersByTimeAsync(1100);
    expect(value.game.isActive).toBe(false);
    expect(storedReference()).toBeNull();
  });

  it("synchronizes a long-running game without HTTP polling or losing application heartbeat", async () => {
    const value = fixture();
    await start(value);
    await vi.advanceTimersByTimeAsync(2 * 15 * 60 * 1000);
    expect(value.game.canMove).toBe(true);
    expect(value.client.capabilities).toHaveBeenCalledOnce();
    expect(value.client.snapshot).not.toHaveBeenCalled();
    expect(value.session().snapshot().clocks.black.timeMs).toBe(1799_999);
  });

  it("does not resurrect a disposed client from a late recovery response", async () => {
    const value = fixture();
    await start(value);
    let complete!: () => void;
    const original = value.client.snapshot.getMockImplementation()!;
    value.client.snapshot.mockImplementationOnce(async (id) => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return original(id);
    });
    value.sockets[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    value.game.dispose();
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.sockets).toHaveLength(1);
    expect(value.records.analysisLocked).toBe(false);
    expect(value.game.isActive).toBe(false);
  });

  it("does not attach from a creation response delivered after disposal", async () => {
    const value = fixture();
    let complete!: () => void;
    const original = value.client.create.getMockImplementation()!;
    value.client.create.mockImplementationOnce(async (request) => {
      const snapshot = await original(request);
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return snapshot;
    });
    const creating = value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(1);
    value.game.dispose();
    complete();
    await creating;
    await vi.advanceTimersByTimeAsync(0);
    expect(value.sockets).toHaveLength(0);
    expect(value.game.isActive).toBe(false);
    expect(value.records.analysisLocked).toBe(false);
  });

  it("sends research annotations over WebSocket without editing the bound document", async () => {
    const value = fixture();
    await start(value);
    value.game.annotate(SearchInfoSenderType.RESEARCHER, {
      usi: value.records.record.usi,
      depth: 10,
      score: 42,
    });
    expect(value.records.record.current.customData).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.records.record.current.customData).toMatchObject({
      researchInfo: { depth: 10, score: 42 },
    });
    expect(
      value.client.command.mock.calls.every(([, command]) => command.action !== "annotate"),
    ).toBe(true);
  });

  it("releases finished-game linkage after failed saves so another game can start", async () => {
    const value = fixture();
    value.settings.black = value.settings.white = { uri: "lan-engine:test", name: "AI" };
    value.settings.repeat = 2;
    value.settings.enableAutoSave = true;
    vi.mocked(value.player.startSearch).mockImplementation(async (_p, _u, _t, handler) =>
      handler.onResign(),
    );
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(10);
    expect(value.game.isActive).toBe(false);
    expect(value.game.hasRetainedSession).toBe(false);
    expect(value.game.status!.records.map((record) => record.state)).toEqual(["failed", "failed"]);
    expect(value.records.analysisLocked).toBe(false);
    expect(storedReference()).toBeNull();
    value.settings.black = value.settings.white = { uri: "es://human", name: "Human" };
    value.settings.repeat = 1;
    value.settings.enableAutoSave = false;
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.client.create).toHaveBeenCalledTimes(2);
    expect(value.game.canMove).toBe(true);
  });

  it("releases an initial edit lock when disposed before capabilities arrive", async () => {
    const value = fixture();
    let complete!: () => void;
    value.client.capabilities.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return value.server.capabilities();
    });
    const starting = value.game.start(value.settings);
    value.game.dispose();
    complete();
    await starting;
    expect(value.client.create).not.toHaveBeenCalled();
    expect(value.records.analysisLocked).toBe(false);
    expect(value.game.isActive).toBe(false);
  });
});
