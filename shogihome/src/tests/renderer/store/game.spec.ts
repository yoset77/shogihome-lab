import { Record, Move, Position, SpecialMoveType, importKIF, Color } from "tsshogi";
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
  type GameFrame,
} from "@/common/game/protocol";
import { SearchInfoSenderType } from "@/common/record/types";
import { defaultGameSettings } from "@/common/settings/game";
import { loadRecordForWebApp } from "@/renderer/store/webapp";
import { fakeGamePlayer } from "@/tests/server/helpers/game";
import { useToastStore } from "@/renderer/store/toast";
import { t } from "@/common/i18n";
import api from "@/renderer/ipc/api";
import { USIMonitor } from "@/renderer/store/usi";
import {
  setOnStartSearchHandler,
  setOnUpdateUSIInfoHandler,
  isInfoSessionActive,
} from "@/renderer/players/usi_events";

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
  return sessionStorage.getItem("shogihome-job-attachment:game");
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
    commandOutcome: vi.fn<GameSessionsClient["commandOutcome"]>(async (id, requestId) =>
      asHttp(() => server.get(id).commandOutcome(requestId)),
    ),
    list: vi.fn(async () => server.list()),
    attach: vi.fn<GameSessionsClient["attach"]>(async (id, input) =>
      asHttp(() => server.get(id).attach(input)),
    ),
    detach: vi.fn<GameSessionsClient["detach"]>(async (id, binding) =>
      asHttp(() => {
        server.get(id).detach(binding);
        return server.get(id).snapshot();
      }),
    ),
    capabilities: vi.fn(async () => server.capabilities()),
    create: vi.fn(async (input: GameSessionRequest) => {
      const session = await asHttp(() => server.create(input));
      request = input;
      return session.snapshot();
    }),
    byRequest: vi.fn(async (id: string) => asHttp(() => server.byRequest(id).publicSnapshot())),
    snapshot: vi.fn<GameSessionsClient["snapshot"]>(async (id, recovery) =>
      asHttp(() => (recovery ? server.get(id).recover(recovery) : server.get(id).publicSnapshot())),
    ),
    command: vi.fn<GameSessionsClient["command"]>(async (id, command, authorization) =>
      asHttp(() => server.get(id).command(command, authorization)),
    ),
  } satisfies GameSessionsClient;
  const sockets: FakeSocket[] = [];
  let socketDelayMs = 0;
  let dropNextFrames: "all" | "snapshot" | undefined;
  class FakeSocket {
    readyState = 0;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    connection?: { disconnect(): void; heartbeat(): void };
    constructor(url: string) {
      sockets.push(this);
      const dropFrames = dropNextFrames;
      dropNextFrames = undefined;
      const connect = () => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        const parsed = new URL(url);
        const binding = decodeGameConnection({
          connectionId: parsed.searchParams.get("connectionId"),
          screenId: parsed.searchParams.get("screenId"),
          recoveryId: parsed.searchParams.get("recoveryId"),
          controllerEpoch: Number(parsed.searchParams.get("controllerEpoch")),
        });
        if (!binding.ok) throw new Error(binding.error);
        try {
          this.connection = server.byRequest(request!.requestId).connect(
            parsed.searchParams.get("controllerId")!,
            (frame: GameFrame) => {
              queueMicrotask(() => {
                if (
                  this.readyState === 1 &&
                  dropFrames !== "all" &&
                  (dropFrames !== "snapshot" || frame.type !== "snapshot")
                )
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
    dropNextConnectionFrames: (frames: "all" | "snapshot" = "all") => {
      dropNextFrames = frames;
    },
    socketFactory,
    error,
    end,
    beat,
    settings,
    saveRecord,
    ...fake,
    session: () => server.byRequest(request!.requestId),
    reload: (screenId?: string) =>
      new GameManager(
        new RecordManager(loadRecordForWebApp()!),
        new GameClockDisplay(),
        new GameClockDisplay(),
        client,
        socketFactory,
        screenId,
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
    sessionStorage.clear();
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
    setOnStartSearchHandler(() => {});
    setOnUpdateUSIInfoHandler(() => {});
  });
  async function start(value: ReturnType<typeof setup>, ai = false) {
    if (ai) value.settings.white = { uri: "lan-engine:test", name: "AI" };
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.error.mock.calls).toEqual([]);
    expect(value.game.canMove).toBe(true);
  }

  function delayCommand(value: ReturnType<typeof setup>) {
    let deliver!: () => void;
    const original = value.client.command.getMockImplementation()!;
    value.client.command.mockImplementationOnce(async (id, command) => {
      await new Promise<void>((resolve) => {
        deliver = resolve;
      });
      return original(id, command);
    });
    return () => deliver();
  }

  it("keeps startup pending until engine readiness, initial position and socket synchronization", async () => {
    const value = fixture();
    value.records.appendMove({ move: value.records.record.position.createMoveByUSI("7g7f")! });
    value.settings.white = { uri: "lan-engine:test", name: "AI" };
    let ready!: () => void;
    vi.spyOn(value.player, "readyNewGame").mockImplementationOnce(
      () => new Promise<void>((resolve) => (ready = resolve)),
    );
    try {
      await value.game.start(value.settings);
      await vi.advanceTimersByTimeAsync(1);
      expect(value.game.status?.state).toBe("preparing");
      expect(value.game.isStarting).toBe(true);
      expect(value.records.record.current.ply).toBe(0);
      expect(value.game.canMove).toBe(false);
      ready();
      await vi.advanceTimersByTimeAsync(1);
      expect(value.game.isStarting).toBe(false);
      expect(value.records.record.current.ply).toBe(0);
      expect(value.game.canMove).toBe(true);
    } finally {
      ready?.();
    }
  });

  async function gameWithBothEnginePVs(repeat = 1) {
    const value = fixture();
    const monitor = new USIMonitor();
    setOnStartSearchHandler((id) => monitor.endIteration(id));
    setOnUpdateUSIInfoHandler((id, position, name, info) => {
      monitor.update(id, position, name, info, 100);
    });
    value.game.on("resetMonitor", (id) => monitor.removeSession(id));
    value.settings.black = { uri: "lan-engine:black", name: "Black Engine" };
    value.settings.white = { uri: "lan-engine:white", name: "White Engine" };
    value.settings.repeat = repeat;
    const emitPV = (name: string, pv: string[]) => {
      const snapshot = value.session().snapshot();
      const frame: GameFrame = {
        type: "clock",
        sessionId: snapshot.sessionId,
        serverInstanceId: snapshot.serverInstanceId,
        revision: snapshot.revision,
        sampleId: snapshot.sampleId,
        clocks: snapshot.clocks,
        infos: [
          {
            color: value.records.record.position.color,
            name,
            position: value.records.record.usi,
            searchId: snapshot.interactionId,
            info: { depth: 8, scoreCP: 42, pv },
          },
        ],
      };
      value.sockets.at(-1)!.onmessage!({ data: JSON.stringify(frame) });
    };
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(1);
    emitPV("Black Engine", ["7g7f", "3c3d"]);
    await vi.advanceTimersByTimeAsync(500);
    value.searches[0].handler.onMove(value.records.record.position.createMoveByUSI("7g7f")!);
    await vi.advanceTimersByTimeAsync(0);
    emitPV("White Engine", ["3c3d", "2g2f"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(monitor.sessions.map((session) => session.name)).toEqual([
      "Black Engine",
      "White Engine",
    ]);
    return { ...value, monitor, emitPV };
  }

  it.each(["human", "engine"])(
    "waits for the initial socket but not the first %s move",
    async (first) => {
      const value = fixture();
      value.settings[first === "human" ? "white" : "black"] = {
        uri: "lan-engine:test",
        name: "AI",
      };
      value.delayConnections(100);
      await value.game.start(value.settings);
      await vi.advanceTimersByTimeAsync(99);
      expect(value.game.isStarting).toBe(true);
      expect(value.game.canMove).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(value.game.isStarting).toBe(false);
      expect(value.records.record.current.ply).toBe(0);
      expect(value.game.canMove).toBe(first === "human");
      expect(value.beat).not.toHaveBeenCalled();
      expect(value.searches).toHaveLength(first === "human" ? 0 : 1);
    },
  );

  it.each(["dispose", "stop", "expired", "transferred"])(
    "ends the initial startup wait on %s while the engine is still preparing",
    async (action) => {
      const value = fixture();
      value.settings.white = { uri: "lan-engine:test", name: "AI" };
      let ready!: () => void;
      const preparing = new Promise<void>((resolve) => (ready = resolve));
      vi.spyOn(value.player, "readyNewGame").mockImplementationOnce(() => preparing);
      try {
        await value.game.start(value.settings);
        await vi.advanceTimersByTimeAsync(1);
        expect(value.game.isStarting).toBe(true);
        if (action === "dispose") value.game.dispose();
        else if (action === "stop") value.game.stop();
        else value.sockets.at(-1)!.close(action === "expired" ? 4004 : 4001);
        await vi.advanceTimersByTimeAsync(0);
        expect(value.game.isStarting).toBe(false);
      } finally {
        ready();
        await vi.advanceTimersByTimeAsync(1);
      }
    },
  );

  it("ends the startup wait on connection loss without releasing the record lock or waiting again", async () => {
    const value = fixture();
    value.settings.white = { uri: "lan-engine:test", name: "AI" };
    let ready!: () => void;
    const preparing = new Promise<void>((resolve) => (ready = resolve));
    vi.spyOn(value.player, "readyNewGame").mockImplementationOnce(() => preparing);
    try {
      await value.game.start(value.settings);
      await vi.advanceTimersByTimeAsync(1);
      expect(value.game.isStarting).toBe(true);
      value.sockets.at(-1)!.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(value.game.isStarting).toBe(false);
      expect(value.records.analysisLocked).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(value.game.status?.state).toBe("preparing");
      expect(value.game.isStarting).toBe(false);
      ready();
      await vi.advanceTimersByTimeAsync(1);
      expect(value.game.canMove).toBe(true);
      expect(value.game.isStarting).toBe(false);
    } finally {
      ready();
    }
  });

  it("ends the startup wait on engine preparation failure", async () => {
    const value = fixture();
    value.settings.white = { uri: "lan-engine:test", name: "AI" };
    vi.spyOn(value.player, "readyNewGame").mockRejectedValueOnce(new Error("Engine failed"));
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.game.isStarting).toBe(false);
    expect(value.game.isActive).toBe(false);
    expect(value.game.status?.state).toBe("failed");
    expect(value.records.analysisLocked).toBe(false);
  });

  it.each([Color.BLACK, Color.WHITE])(
    "clears previous engine PVs before starting a game with only the %s engine",
    async (engineColor) => {
      const value = await gameWithBothEnginePVs();
      const ids = value.monitor.sessions.map((session) => session.sessionID);
      value.searches[1].handler.onResign();
      await vi.advanceTimersByTimeAsync(0);
      expect(value.game.isActive).toBe(false);
      value.settings[engineColor === Color.BLACK ? Color.WHITE : Color.BLACK] = {
        uri: "es://human",
        name: "Human",
      };
      await value.game.start(value.settings);
      await vi.advanceTimersByTimeAsync(1);
      expect(value.monitor.sessions).toEqual([]);
      expect(isInfoSessionActive(ids[0])).toBe(engineColor === Color.BLACK);
      expect(isInfoSessionActive(ids[1])).toBe(engineColor === Color.WHITE);
      if (engineColor === Color.WHITE) {
        await value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
        await vi.advanceTimersByTimeAsync(0);
      }
      const name = value.settings[engineColor].name;
      const pv = engineColor === Color.BLACK ? ["2g2f", "8c8d"] : ["8c8d", "2g2f"];
      value.emitPV(name, pv);
      await vi.advanceTimersByTimeAsync(500);
      expect(value.monitor.sessions).toHaveLength(1);
      expect(value.monitor.sessions[0].name).toBe(name);
      expect(value.monitor.sessions[0].latestInfo[0].pv).toEqual(pv);
      expect(value.monitor.sessions[0].latestInfo[0].color).toBe(engineColor);
    },
  );

  it("beeps at the remaining-time thresholds while clocks stay synchronized", async () => {
    const value = fixture();
    value.settings.timeLimit = { timeSeconds: 15, byoyomi: 0, increment: 0 };
    const beepShort = vi.fn();
    const beepUnlimited = vi.fn();
    value.game.on("beepShort", beepShort).on("beepUnlimited", beepUnlimited);
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(1);
    // 1-second clock frames count the remaining time down from 15 to 1.
    for (let second = 1; second <= 14; second++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(beepShort).toHaveBeenCalledTimes(5);
    expect(beepUnlimited).toHaveBeenCalledTimes(5);
  });

  it("starts an engine game in the background without replacing the displayed record", async () => {
    const value = fixture();
    value.settings.black = { uri: "lan-engine:black", name: "Black" };
    value.settings.white = { uri: "lan-engine:white", name: "White" };
    value.records.updateComment("Current local record");
    await value.game.start(value.settings, true);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.game.isActive).toBe(false);
    expect(value.game.isStarting).toBe(false);
    expect(value.records.analysisLocked).toBe(false);
    expect(value.records.record.current.comment).toBe("Current local record");
    expect(storedReference()).toBeNull();
    expect(value.sockets).toHaveLength(0);
    expect(value.server.list()).toHaveLength(1);
    expect(value.searches).toHaveLength(1);
  });

  it("detaches engine games without stopping and attaches from another device", async () => {
    const value = fixture();
    value.settings.black = { uri: "lan-engine:black", name: "Black" };
    value.settings.white = { uri: "lan-engine:white", name: "White" };
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(1);
    value.game.detachJob();
    await vi.advanceTimersByTimeAsync(1);
    expect(value.game.isActive).toBe(false);
    expect(storedReference()).toBeNull();
    expect(value.session().snapshot().state).toBe("running");
    value.records.updateComment("Detached local work");
    value.searches[0].handler.onMove(value.records.record.position.createMoveByUSI("7g7f")!);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.records.record.current.comment).toBe("Detached local work");
    localStorage.clear();
    sessionStorage.clear();
    const other = value.reload();
    extraClients.push(other);
    expect(
      await other.attach(
        value.server.list()[0],
        async () => true,
        async () => true,
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(other.isActive).toBe(true);
    expect(other.status?.record.nodes).toHaveLength(2);
  });

  it("never offers human-game detachment or background execution", async () => {
    const value = fixture();
    await expect(value.game.start(value.settings, true)).rejects.toThrow();
    await start(value);
    expect(value.game.canDetach).toBe(false);
    value.game.detachJob();
    expect(value.game.isActive).toBe(true);
    expect(value.server.list()).toEqual([]);
  });

  it("recovers a delivered attachment with its original owner and takeover decision", async () => {
    const value = fixture();
    value.settings.black = { uri: "lan-engine:black", name: "Black" };
    value.settings.white = { uri: "lan-engine:white", name: "White" };
    await value.game.start(value.settings, true);
    const claim = value.client.attach.getMockImplementation()!;
    value.client.attach.mockImplementationOnce(async (id, request) => {
      await claim(id, request);
      throw new TypeError("Attachment response lost");
    });
    expect(
      await value.game.attach(
        value.server.list()[0],
        async () => true,
        async () => true,
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(value.game.isActive).toBe(true);
    expect(value.game.status?.sessionId).toBe(value.session().id);
    expect(value.client.attach).toHaveBeenCalledTimes(2);
    expect(value.client.attach.mock.calls[0][1]).toEqual(value.client.attach.mock.calls[1][1]);
  });

  it("clears engine PVs at the next round of repeated games even at the same position", async () => {
    const value = await gameWithBothEnginePVs(2);
    value.searches[1].handler.onResign();
    await vi.advanceTimersByTimeAsync(1);
    expect(value.game.status?.gameNumber).toBe(2);
    expect(value.game.isStarting).toBe(false);
    expect(value.monitor.sessions).toEqual([]);
    value.emitPV("Black Engine", ["2g2f", "8c8d"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(value.monitor.sessions).toHaveLength(1);
    expect(value.monitor.sessions[0].latestInfo[0].pv).toEqual(["2g2f", "8c8d"]);
  });

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
    const recovered = value.reload("replacement-screen");
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
    expect(localStorage.getItem("shogihome-game-session:other-request")).toBe(other);
    expect(storedReference()).toBeNull();
    expect(value.game.hasRetainedSession).toBe(false);
    expect(value.records.analysisLocked).toBe(false);
  });

  it("migrates legacy linkage into a journal without creating attachment intent", async () => {
    const value = fixture();
    await start(value);
    value.game.dispose();
    const reference = storedReference()!;
    localStorage.setItem("shogihome-game-session", reference);
    sessionStorage.clear();
    const recovered = value.reload();
    extraClients.push(recovered);
    expect(await recovered.resume(async () => true)).toBe(false);
    await recovered.reconcilePending();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered.canMove).toBe(false);
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(localStorage.getItem("shogihome-game-session")).toBeNull();
    expect(storedReference()).toBeNull();
  });

  it("only reconciles a lost creation journal when the tab has no attachment intent", async () => {
    const value = fixture();
    const original = value.client.create.getMockImplementation()!;
    value.client.create.mockImplementationOnce(async (request) => {
      await original(request);
      throw new TypeError("Response lost");
    });
    await value.game.start(value.settings);
    value.game.dispose();
    sessionStorage.clear();
    const recovered = value.reload();
    extraClients.push(recovered);
    const error = vi.fn();
    recovered.on("error", error);
    expect(await recovered.resume(async () => true)).toBe(false);
    await recovered.reconcilePending();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered.canMove).toBe(false);
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(
      Object.keys(localStorage).some((key) => key.startsWith("shogihome-job-journal:game:")),
    ).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it.each(["initial", "reconnect"] as const)(
    "retries a silent %s socket before receiving its first snapshot",
    async (phase) => {
      const value = fixture();
      if (phase === "reconnect") {
        await start(value);
        value.dropNextConnectionFrames();
        value.sockets[0].close();
        await vi.advanceTimersByTimeAsync(1000);
      } else {
        value.dropNextConnectionFrames();
        await value.game.start(value.settings);
        await vi.advanceTimersByTimeAsync(0);
      }
      const socket = value.sockets.at(-1)!;
      const send = vi.spyOn(socket, "send");
      const lateFrame = socket.onmessage!;
      const reference = JSON.parse(storedReference()!);
      await vi.advanceTimersByTimeAsync(9999);
      expect(socket.readyState).toBe(1);
      expect(value.game.isStarting).toBe(phase === "initial");
      expect(value.game.canMove).toBe(false);
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.readyState).toBe(3);
      expect(value.game.isStarting).toBe(false);
      expect(value.game.isActive).toBe(true);
      expect(value.records.analysisLocked).toBe(true);
      expect(JSON.parse(storedReference()!).requestId).toBe(reference.requestId);
      lateFrame({ data: JSON.stringify({ type: "snapshot", value: value.session().snapshot() }) });
      expect(value.game.canMove).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(value.sockets).toHaveLength(phase === "initial" ? 2 : 3);
      expect(value.game.canMove).toBe(true);
      expect(value.client.create).toHaveBeenCalledOnce();
      expect(value.error).not.toHaveBeenCalled();
    },
  );

  it("times out the initial snapshot even when clock frames keep arriving", async () => {
    const value = fixture();
    value.dropNextConnectionFrames("snapshot");
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(0);
    const socket = value.sockets[0];
    const send = vi.spyOn(socket, "send");
    const receive = vi.spyOn(socket, "onmessage");
    await vi.advanceTimersByTimeAsync(9999);
    expect(receive).toHaveBeenCalled();
    expect(socket.readyState).toBe(1);
    expect(value.game.canMove).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.readyState).toBe(3);
    expect(value.records.analysisLocked).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.sockets).toHaveLength(2);
    expect(value.game.canMove).toBe(true);
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(value.error).not.toHaveBeenCalled();
  });

  it("retries a socket whose opening handshake never completes", async () => {
    const value = fixture();
    value.delayConnections(60_000);
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(9999);
    expect(value.sockets[0].readyState).toBe(0);
    expect(value.game.canMove).toBe(false);
    value.delayConnections(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.sockets[0].readyState).toBe(3);
    expect(value.records.analysisLocked).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.sockets).toHaveLength(2);
    expect(value.game.canMove).toBe(true);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(value.sockets).toHaveLength(2);
    expect(value.game.canMove).toBe(true);
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(value.error).not.toHaveBeenCalled();
  });

  it("stops initial snapshot timeout monitoring when the client is disposed", async () => {
    const value = fixture();
    value.dropNextConnectionFrames();
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(0);
    value.game.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(value.game.isActive).toBe(false);
    expect(value.records.analysisLocked).toBe(false);
    expect(value.sockets).toHaveLength(1);
    expect(value.client.capabilities).toHaveBeenCalledOnce();
    expect(value.client.snapshot).not.toHaveBeenCalled();
    expect(value.error).not.toHaveBeenCalled();
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

  it("recovers a lost initial socket snapshot after reloading into a new screen", async () => {
    const value = fixture();
    value.dropNextConnectionFrames();
    await value.game.start(value.settings);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.game.canMove).toBe(false);
    const previous = value.session().snapshot();
    expect(previous.controllerConnectionId).toBeDefined();
    value.game.dispose();

    const recovered = value.reload("reloaded-screen");
    extraClients.push(recovered);
    const error = vi.fn();
    recovered.on("error", error);
    expect(await recovered.resume(async () => true)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(recovered.canMove).toBe(true);
    expect(recovered.status?.sessionId).toBe(previous.sessionId);
    expect(recovered.status?.controllerConnectionId).not.toBe(previous.controllerConnectionId);
    expect(storedReference()).not.toBeNull();
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not open a socket if its recovery identity cannot be persisted", async () => {
    const value = fixture();
    const original = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      raw: string,
    ) {
      if (key === "shogihome-job-attachment:game" && JSON.parse(raw).connectionId)
        throw new Error("Storage full");
      original.call(this, key, raw);
    });

    await expect(value.game.start(value.settings)).rejects.toThrow("Storage full");
    write.mockRestore();

    expect(value.sockets).toHaveLength(0);
    expect(value.session().snapshot().controllerEpoch).toBe(0);
    expect(value.session().snapshot().controllerConnectionId).toBeUndefined();
    expect(storedReference()).not.toBeNull();
    const recovered = value.reload("reloaded-screen");
    extraClients.push(recovered);
    expect(await recovered.resume(async () => true)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(recovered.canMove).toBe(true);
    expect(value.client.create).toHaveBeenCalledOnce();
  });

  it.each(["accepted", "pending"] as const)(
    "recovers an established game reloaded again while its socket handshake is %s",
    async (handshake) => {
      const value = fixture();
      await start(value);
      for (const move of ["7g7f", "3c3d", "2g2f"]) {
        await value.game.move(value.records.record.position.createMoveByUSI(move)!);
        await vi.advanceTimersByTimeAsync(0);
      }
      const previous = value.session().snapshot();
      expect(previous.lastMoveId).toBe(3);
      value.game.dispose();

      if (handshake === "accepted") value.dropNextConnectionFrames();
      else value.delayConnections(60_000);
      const firstReload = value.reload("first-reloaded-screen");
      extraClients.push(firstReload);
      expect(await firstReload.resume(async () => true)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(firstReload.canMove).toBe(false);
      expect(value.sockets.at(-1)?.readyState).toBe(handshake === "accepted" ? 1 : 0);
      firstReload.dispose();

      value.delayConnections(0);
      const secondReload = value.reload("second-reloaded-screen");
      extraClients.push(secondReload);
      const error = vi.fn();
      secondReload.on("error", error);
      expect(await secondReload.resume(async () => true)).toBe(true);
      // An unopened socket cannot release the first recovered screen's HTTP lease.
      await vi.advanceTimersByTimeAsync(handshake === "pending" ? 31_001 : 1);

      expect(secondReload.canMove).toBe(true);
      expect(secondReload.status).toMatchObject({
        sessionId: previous.sessionId,
        gameId: previous.gameId,
        lastMoveId: 3,
      });
      expect(loadRecordForWebApp()?.usi).toBe("position startpos moves 7g7f 3c3d 2g2f");
      expect(storedReference()).not.toBeNull();
      expect(value.client.create).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
    },
  );

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

  it("previews delayed human moves without changing the confirmed record or its edit lock", async () => {
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
    expect(game.displayPosition.sfen).not.toBe(records.record.position.sfen);
    expect(game.displayLastMove?.usi).toBe("7g7f");
    expect(value.session().snapshot().record.nodes).toHaveLength(1);
    expect(loadRecordForWebApp()!.current.ply).toBe(0);
    expect(value.beat).toHaveBeenCalledOnce();
    expect(game.canMove).toBe(false);
    expect(game.canTakeback).toBe(false);
    await game.move(records.record.position.createMoveByUSI("2g2f")!);
    expect(
      client.command.mock.calls.filter(([, command]) => command.action === "move"),
    ).toHaveLength(1);
    complete();
    await move;
    await vi.advanceTimersByTimeAsync(0);
    expect(records.record.current.ply).toBe(1);
    expect(game.displayPosition.sfen).toBe(records.record.position.sfen);
    expect(value.beat).toHaveBeenCalledOnce();
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

  it.each([
    ["promotion and capture", "4k4/4p4/4P4/9/9/9/9/9/4K4 b - 1", "5c5b+"],
    ["drop", "4k4/9/9/9/9/9/9/9/4K4 b P 1", "P*7f"],
    ["white move", "4k4/9/9/9/9/9/4p4/9/4K4 w - 1", "5g5h+"],
  ])("previews %s with the correct board and hands", async (_label, sfen, usi) => {
    const value = fixture();
    (value.records.record as Record).clear(Position.newBySFEN(sfen)!);
    value.settings.startPosition = "current";
    await start(value);
    const deliver = delayCommand(value);
    const expected = value.records.record.position.clone();
    const move = expected.createMoveByUSI(usi)!;
    expect(expected.doMove(move)).toBe(true);
    const moving = value.game.move(move);
    expect(value.game.displayPosition.sfen).toBe(expected.sfen);
    expect(value.game.displayLastMove?.usi).toBe(usi);
    expect(value.records.record.position.sfen).toBe(sfen);
    expect(value.beat).toHaveBeenCalledOnce();
    deliver();
    await moving;
    expect(value.records.record.position.sfen).toBe(expected.sfen);
    expect(value.beat).toHaveBeenCalledOnce();
  });

  it("does not preview illegal moves or send them to the server", async () => {
    const value = fixture();
    await start(value);
    const calls = value.client.command.mock.calls.length;
    await expect(
      value.game.move(value.records.record.position.createMoveByUSI("7g7e")!),
    ).rejects.toThrow(t.gameInvalid);
    expect(value.game.displayPosition.sfen).toBe(value.records.record.position.sfen);
    expect(value.game.displayLastMove).toBeUndefined();
    expect(value.game.canMove).toBe(true);
    expect(value.client.command).toHaveBeenCalledTimes(calls);
    expect(value.beat).not.toHaveBeenCalled();
  });

  it("requires the durable move journal before previewing or sending a move", async () => {
    const value = fixture();
    await start(value);
    const calls = value.client.command.mock.calls.length;
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    await expect(
      value.game.move(value.records.record.position.createMoveByUSI("7g7f")!),
    ).rejects.toThrow("Storage full");
    expect(value.game.displayPosition.sfen).toBe(value.records.record.position.sfen);
    expect(value.game.canMove).toBe(true);
    expect(value.client.command).toHaveBeenCalledTimes(calls);
    expect(value.beat).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  it.each([400, 409])(
    "discards the preview when the server rejects the move with %s",
    async (status) => {
      const value = fixture();
      await start(value);
      let reject!: () => void;
      value.client.command.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          reject = resolve;
        });
        throw new ApiResponseError(status, "Move rejected");
      });
      const moving = value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
      expect(value.game.displayLastMove?.usi).toBe("7g7f");
      reject();
      if (status === 400) await expect(moving).rejects.toMatchObject({ status });
      else await moving;
      expect(value.game.displayPosition.sfen).toBe(value.records.record.position.sfen);
      expect(value.game.displayLastMove).toBeUndefined();
      expect(value.game.canMove).toBe(true);
      expect(value.beat).toHaveBeenCalledOnce();
    },
  );

  it("keeps the preview across same-turn snapshots, clock frames and selected future branches", async () => {
    const value = fixture();
    value.records.appendMove({ move: value.records.record.position.createMoveByUSI("7g7f")! });
    value.records.goBack();
    value.settings.startPosition = "current";
    await start(value);
    const deliver = delayCommand(value);
    const moving = value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
    const expected = value.game.displayPosition.sfen;
    const snapshot = value.session().snapshot();
    expect(snapshot.record.selectedPath).toHaveLength(2);
    snapshot.revision += 1;
    snapshot.recordRevision += 1;
    snapshot.record.nodes[0].comment = "Server annotation";
    value.sockets.at(-1)!.onmessage!({
      data: JSON.stringify({ type: "snapshot", value: snapshot }),
    });
    expect(value.records.record.current.comment).toBe("Server annotation");
    expect(value.records.record.current.ply).toBe(0);
    expect(value.game.displayPosition.sfen).toBe(expected);
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.game.displayPosition.sfen).toBe(expected);
    expect(value.beat).toHaveBeenCalledOnce();
    deliver();
    await moving;
    expect(value.records.record.current.ply).toBe(1);
    expect(value.beat).toHaveBeenCalledOnce();
  });

  it("accepts WebSocket confirmation and an engine reply before a stale HTTP response", async () => {
    const value = fixture();
    await start(value, true);
    let respond!: () => void;
    const original = value.client.command.getMockImplementation()!;
    value.client.command.mockImplementationOnce(async (id, command) => {
      const response = await original(id, command);
      await new Promise<void>((resolve) => {
        respond = resolve;
      });
      return response;
    });
    const moving = value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
    expect(value.beat).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.records.record.current.ply).toBe(1);
    expect(value.game.displayPosition.sfen).toBe(value.records.record.position.sfen);
    expect(value.beat).toHaveBeenCalledOnce();
    value.searches[0].handler.onMove(value.records.record.position.createMoveByUSI("3c3d")!);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.game.displayLastMove?.usi).toBe("3c3d");
    expect(value.beat).toHaveBeenCalledTimes(2);
    respond();
    await moving;
    expect(value.records.record.current.ply).toBe(2);
    expect(value.game.displayLastMove?.usi).toBe("3c3d");
    expect(value.beat).toHaveBeenCalledTimes(2);
  });

  it("reconciles a snapshot containing both the human move and the engine reply", async () => {
    const value = fixture();
    await start(value, true);
    const socket = value.sockets.at(-1)!;
    const receive = socket.onmessage!;
    socket.onmessage = (event) => {
      if (JSON.parse(event.data).type !== "snapshot") receive(event);
    };
    const original = value.client.command.getMockImplementation()!;
    value.client.command.mockImplementationOnce(async (id, command) => {
      await original(id, command);
      const position = (Record.newByUSI(value.searches[0].usi) as Record).position;
      value.searches[0].handler.onMove(position.createMoveByUSI("3c3d")!);
      return value.session().snapshot();
    });
    const moving = value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
    expect(value.beat).toHaveBeenCalledOnce();
    await moving;
    await vi.advanceTimersByTimeAsync(0);
    expect(value.records.record.current.ply).toBe(2);
    expect(value.game.displayPosition.sfen).toBe(value.records.record.position.sfen);
    expect(value.game.displayLastMove?.usi).toBe("3c3d");
    expect(value.beat).toHaveBeenCalledTimes(2);
  });

  it("discards an unconfirmed preview on timeout without adding it to the final record", async () => {
    const value = fixture();
    value.settings.timeLimit = { timeSeconds: 1, byoyomi: 0, increment: 0 };
    await start(value, true);
    const deliver = delayCommand(value);
    const moving = value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
    expect(value.game.displayLastMove?.usi).toBe("7g7f");
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.game.isActive).toBe(false);
    expect(value.records.record.current.move).toEqual({ type: SpecialMoveType.TIMEOUT });
    expect(value.game.displayLastMove).toBeUndefined();
    expect(value.game.displayPosition.sfen).toBe(value.records.record.position.sfen);
    deliver();
    await moving;
    expect(value.records.record.moves.some((node) => node.move instanceof Move)).toBe(false);
    expect(value.beat).toHaveBeenCalledOnce();
  });

  it("clears the preview on disposal and ignores a late move response", async () => {
    const value = fixture();
    await start(value);
    const deliver = delayCommand(value);
    const moving = value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
    expect(value.game.displayLastMove?.usi).toBe("7g7f");
    value.game.dispose();
    expect(value.game.displayPosition.sfen).toBe(value.records.record.position.sfen);
    expect(value.game.displayLastMove).toBeUndefined();
    deliver();
    await moving;
    expect(value.game.isActive).toBe(false);
    expect(value.game.displayLastMove).toBeUndefined();
    expect(value.records.record.current.ply).toBe(0);
  });

  it("never rewrites an undelivered move after reconnect changes the turn generation", async () => {
    const value = fixture();
    await start(value);
    value.client.command.mockRejectedValueOnce(new TypeError("Move not delivered"));
    await value.game.move(value.records.record.position.createMoveByUSI("7g7f")!);
    expect(value.records.record.current.ply).toBe(0);
    expect(value.game.displayLastMove?.usi).toBe("7g7f");
    expect(value.game.canMove).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    const attempts = value.client.command.mock.calls.filter(
      ([, command]) => command.action === "move",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0][1]).toEqual(attempts[1][1]);
    expect(value.records.record.current.ply).toBe(0);
    expect(value.session().snapshot().record.nodes).toHaveLength(1);
    expect(value.game.displayPosition.sfen).toBe(value.records.record.position.sfen);
    expect(value.game.displayLastMove).toBeUndefined();
    expect(value.beat).toHaveBeenCalledOnce();
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
    const key = Object.keys(localStorage).find(
      (key) => key.startsWith("shogihome-job-journal:game:") && key.endsWith(":stop"),
    )!;
    expect(JSON.parse(localStorage.getItem(key)!).stopRequested).toBe(true);
    expect(JSON.parse(storedReference()!).stopRequested).toBeUndefined();
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

  it("does not replay an interrupt that could not be durably recorded", async () => {
    const value = fixture();
    await start(value);
    const original = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      content,
    ) {
      if (this === localStorage && key.startsWith("shogihome-job-journal:"))
        throw new Error("Storage full");
      original.call(this, key, content);
    });
    value.game.stop();
    write.mockRestore();
    value.sockets[0].close();
    await vi.advanceTimersByTimeAsync(1100);
    expect(
      value.client.command.mock.calls.filter(([, command]) => command.action === "interrupt"),
    ).toEqual([]);
    expect(value.game.isActive).toBe(true);
    expect(value.error).toHaveBeenCalledOnce();
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
