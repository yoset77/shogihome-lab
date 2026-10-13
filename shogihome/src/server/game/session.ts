import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Color, SpecialMoveType, exportKIF, type ImmutableNode } from "tsshogi";
import { GameRecord } from "@/common/game/record";
import {
  type GameCommand,
  type GameFrame,
  type GameSessionRequest,
  type GameSnapshot,
  type GameClocks,
  type GameError,
  type GameRecordSummary,
  type GameConnection,
  type GameRecoveryRequest,
} from "@/common/game/protocol";
import {
  restoreRecord,
  snapshotRecord,
  indexRecordNodes,
  restoreSearchInfo,
  type RecordSnapshot,
} from "@/common/record/snapshot";
import { ES_HUMAN } from "@/common/uri";
import { t } from "@/common/i18n";
import { fetchEngineConfigs, toLanEngineInfo } from "@/server/engine/list";
import { InternalEngine, type GameEngine } from "@/server/engine/internal";
import type { ResourceLease } from "@/server/engine/resources";
import type { EngineConfig } from "@/server/engine/types";
import { HttpError } from "@/server/errors";
import type { USIInfoCommand } from "@/common/game/usi";
import { parseUSIPV } from "@/common/game/usi";
import type { RecordCustomData } from "@/common/record/types";
import { Clock } from "./clock";
import { GameController, type PlayerBuilder } from "./controller";
import { GamePlayer, HumanPlayer } from "./player";
import { GameBook } from "./book";
import { loadGamePositions, saveGameRecord } from "./files";
import { addHistory, saveBackup } from "@/server/file/history";
import { GAME_DETACHED_TTL_MS } from "@/server/config";
import type {
  JobAttachRequest,
  JobAttachmentState,
  JobBinding,
  JobSummary,
} from "@/common/jobs/types";
import {
  claimJobControl,
  isCurrentJobBinding,
  authorizeJobOperation,
  type JobControl,
} from "@/server/jobs/control";

export const GAME_HEARTBEAT_MS = 5000;
export const GAME_CONTROLLER_TIMEOUT_MS = 30_000;
export const MAX_GAME_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type GameDependencies = {
  createEngine?: () => GameEngine;
  resolveEngine?: (id: string) => Promise<EngineConfig>;
  // Reserves the shared budget for both engines before the game starts.
  // The production manager wires the default provider; tests without it
  // skip resource accounting.
  acquireResourceLease?: (
    settings: GameSessionRequest["settings"],
  ) => Promise<ResourceLease | undefined>;
  loadPositions?: (uri: string) => Promise<string[]>;
  saveRecord?: typeof saveGameRecord;
  addHistory?: typeof addHistory;
  saveBackup?: typeof saveBackup;
  playerBuilder?: PlayerBuilder;
  now?: () => number;
};

async function resolveEngine(id: string): Promise<EngineConfig> {
  const engine = (await fetchEngineConfigs()).find((config) => config.id === id);
  if (!engine || !toLanEngineInfo(engine)?.type?.includes("game"))
    throw new Error("Unknown game engine");
  return engine;
}
export { resolveEngine as resolveGameEngine };

export class GameSession {
  private readonly records: GameRecord;
  private readonly blackClock: Clock;
  private readonly whiteClock: Clock;
  private readonly core: GameController;
  private readonly now: () => number;
  readonly createdAt = Date.now();
  private detachedSince?: number;
  private closing?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly nodeIds = new WeakMap<ImmutableNode, string>();
  private readonly issuedIds = new Set<string>();
  private nextNodeId = 0;
  private revision = 0;
  private recordRevision = 0;
  private sampleId = 0;
  private lastMoveId = 0;
  private controllerEpoch = 0;
  private controllerGeneration = 0;
  private controllerRecoveryId = randomUUID();
  private acquisitionEpoch?: number;
  private screenId?: string;
  private controllerId: string;
  private claimedAt = 0;
  private controllerConnectionId?: string;
  private controller?: {
    epoch: number;
    lastSeen: number;
    send: (frame: GameFrame) => void;
    close: (code?: number) => void;
  };
  private error?: GameError;
  private lastResult?: SpecialMoveType;
  private terminal = false;
  private resourceLease?: ResourceLease;
  private summaries: GameRecordSummary[] = [];
  private commands = new Map<
    string,
    { hash: string; result: Promise<void>; state: "pending" | "accepted" | "rejected" }
  >();
  private infos = new Map<
    string,
    { color: Color; name: string; position: string; searchId: number; info: USIInfoCommand }
  >();
  private annotationsDirty = false;
  private timer?: ReturnType<typeof setInterval>;
  private complete!: () => void;
  readonly completion = new Promise<void>((resolve) => {
    this.complete = resolve;
  });
  endedAt?: number;

  constructor(
    readonly id: string,
    readonly request: GameSessionRequest,
    private readonly deps: GameDependencies = {},
  ) {
    this.now = deps.now ?? (() => performance.now());
    this.controllerId = request.controllerId;
    this.detachedSince = this.now();
    const restored = restoreRecord(request.source);
    this.records = new GameRecord(restored.record);
    for (const [id, node] of restored.nodes) {
      this.nodeIds.set(node, id);
      this.issuedIds.add(id);
    }
    this.blackClock = new Clock(deps.now);
    this.whiteClock = new Clock(deps.now);
    this.core = new GameController(this.records, this.blackClock, this.whiteClock, {
      loadPositions: deps.loadPositions ?? loadGamePositions,
      language: request.options.language,
      commentFormat: request.options.commentFormat,
    })
      .on("update", () => this.publish())
      .on("pieceBeat", () => {
        ++this.lastMoveId;
      })
      .on("recordEnd", () => this.saveFinishedRecord())
      .on("gameEnd", (_results, result) => {
        this.lastResult = result;
        this.finish();
      })
      .on("error", (error) => this.fail(error));
    this.core.setConnected(false);
  }
  get gameId(): string {
    return `${this.id}_${this.core.gameNumber}`;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.expireDetached();
      const controller = this.controller;
      if (!controller) return;
      if (Date.now() - controller.lastSeen >= GAME_CONTROLLER_TIMEOUT_MS) {
        this.disconnect(controller.epoch);
        controller.close(1013);
      } else if (!this.terminal) {
        this.pruneLiveInfos();
        if (this.annotationsDirty) this.publish();
        controller.send({
          type: "clock",
          sessionId: this.id,
          serverInstanceId: this.request.serverInstanceId,
          revision: this.revision,
          sampleId: ++this.sampleId,
          clocks: this.clocks(),
          infos: [...this.infos.values()],
        });
      }
    }, 1000);
    this.timer.unref();
    queueMicrotask(() => {
      void this.run();
    });
  }

  private expireDetached(): void {
    if (
      !this.controller &&
      this.detachedSince !== undefined &&
      this.core.isPaused &&
      this.now() - this.detachedSince >= GAME_DETACHED_TTL_MS
    ) {
      this.abort.abort();
      this.core.stop();
    }
  }

  private async run(): Promise<void> {
    if (this.abort.signal.aborted) {
      this.finish();
      return;
    }
    try {
      // Reserve the shared budget before either engine is launched. AI
      // engines search alternately (no ponder), so the reservation is the
      // per-group maximum of both engines, held for the whole session.
      if (this.deps.acquireResourceLease) {
        this.resourceLease = await this.deps.acquireResourceLease(this.request.settings);
      }
      const builder: PlayerBuilder = this.deps.playerBuilder ?? {
        build: async (settings, onInfo) => {
          if (settings.uri === ES_HUMAN) return new HumanPlayer();
          const config = await (this.deps.resolveEngine ?? resolveEngine)(
            settings.uri === "lan-engine" ? "game" : settings.uri.substring(11),
          );
          if (this.abort.signal.aborted) throw new Error("Game startup cancelled");
          settings.name = config.name;
          const extra = settings.usi?.extraBook;
          const book = extra?.enabled ? await GameBook.open(extra) : undefined;
          const player = new GamePlayer(
            (this.deps.createEngine ?? (() => new InternalEngine()))(),
            book,
            extra,
            onInfo,
            (position, info) => {
              if (!info || !this.core.isActive || this.records.record.usi !== position) return;
              this.pruneLiveInfos();
              const color = this.records.record.position.color;
              const multipv = info.multipv ?? 1;
              const key = `${color}:${multipv}`;
              if (!this.infos.has(key) && this.infos.size >= 32) return;
              // Engines emit partial info lines; merge them per MultiPV like analysis jobs.
              const merged = { ...this.infos.get(key)?.info, ...info, multipv };
              if (info.scoreCP !== undefined || info.scoreMate !== undefined) {
                merged.scoreCP = info.scoreCP;
                merged.scoreMate = info.scoreMate;
                merged.lowerbound = info.lowerbound;
                merged.upperbound = info.upperbound;
              }
              this.infos.set(key, {
                color,
                name: config.name,
                position,
                searchId: this.core.interactionId,
                info: merged,
              });
            },
          );
          try {
            await player.launch(
              config,
              this.request.options.engineTimeoutSeconds,
              this.abort.signal,
              this.resourceLease,
            );
          } catch (error) {
            await player.close().catch(() => {});
            throw error;
          }
          return player;
        },
      };
      await this.core.start(structuredClone(this.request.settings), builder);
      this.publish();
    } catch (error) {
      if (!this.abort.signal.aborted) {
        console.error("Game startup failed", error);
        this.error = error instanceof HttpError ? "capacity" : "engine";
      }
      this.finish();
    }
  }

  private indexed(): Map<string, ImmutableNode> {
    const result = new Map<string, ImmutableNode>();
    for (const node of indexRecordNodes(this.records.record).values()) {
      let id = this.nodeIds.get(node);
      if (!id) {
        do {
          id = `g_${++this.nextNodeId}`;
        } while (this.issuedIds.has(id));
        this.nodeIds.set(node, id);
      }
      result.set(id, node);
    }
    return result;
  }
  private source(): RecordSnapshot {
    return snapshotRecord(this.records.record, this.indexed());
  }
  private clocks(): GameClocks {
    const read = (clock: Clock) => {
      const value = clock.snapshot();
      return {
        timeMs: value.timeMs,
        byoyomiMs: value.byoyomiMs,
        elapsedMs: value.elapsedMs,
        running: clock.running,
      };
    };
    return { black: read(this.blackClock), white: read(this.whiteClock) };
  }
  private state(): GameSnapshot["state"] {
    return this.terminal
      ? this.error && this.error !== "save"
        ? "failed"
        : "completed"
      : this.core.isPaused
        ? "paused"
        : this.core.isTakingBack
          ? "takingBack"
          : this.core.isActive
            ? "running"
            : this.core.phase === "busy"
              ? "finishing"
              : "preparing";
  }
  summary(): JobSummary {
    const settings = this.core.gameNumber ? this.core.settings : this.request.settings;
    return {
      kind: "game",
      id: this.id,
      requestId: this.request.requestId,
      serverInstanceId: this.request.serverInstanceId,
      createdAt: this.createdAt,
      state:
        this.terminal && this.lastResult === SpecialMoveType.INTERRUPT && !this.error
          ? "cancelled"
          : this.state(),
      engines: [settings.black.name, settings.white.name],
      completed: this.terminal ? this.core.gameNumber : Math.max(0, this.core.gameNumber - 1),
      total: this.request.settings.repeat,
      attachment: this.attachment(),
    };
  }
  snapshot(): GameSnapshot {
    return {
      controllerGeneration: this.controllerGeneration,
      controllerRecoveryId: this.controllerRecoveryId,
      controllerOwnerId: this.controllerId,
      sessionId: this.id,
      requestId: this.request.requestId,
      serverInstanceId: this.request.serverInstanceId,
      controllerEpoch: this.controllerEpoch,
      ...(this.controllerConnectionId === undefined
        ? {}
        : { controllerConnectionId: this.controllerConnectionId }),
      revision: this.revision,
      recordRevision: this.recordRevision,
      sampleId: ++this.sampleId,
      gameId: this.gameId,
      gameNumber: this.core.gameNumber,
      interactionId: this.core.interactionId,
      state: this.state(),
      settings: structuredClone(this.core.gameNumber ? this.core.settings : this.request.settings),
      record: this.source(),
      clocks: this.clocks(),
      results: structuredClone(this.core.results),
      canMove: !!this.controller && this.core.isActive && this.core.isHumanTurn,
      canTakeback: !!this.controller && this.core.canTakeback,
      supportsTakeback: this.core.supportsTakeback,
      lastMoveId: this.lastMoveId,
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
      ...(this.error ? { error: this.error } : {}),
      records: structuredClone(this.summaries),
    };
  }
  publicSnapshot(): GameSnapshot {
    const snapshot = this.snapshot();
    delete snapshot.controllerOwnerId;
    delete snapshot.controllerRecoveryId;
    delete snapshot.controllerConnectionId;
    return snapshot;
  }
  creationSnapshot(): GameSnapshot {
    return this.controllerId === this.request.controllerId
      ? this.snapshot()
      : this.publicSnapshot();
  }

  private control(): JobControl {
    return {
      ownerId: this.controllerId,
      epoch: this.controllerEpoch,
      acquisitionEpoch: this.acquisitionEpoch,
      recoveryId: this.controllerRecoveryId,
      screenId: this.screenId,
      attached: this.attachment().attached,
    };
  }

  recover(request: GameRecoveryRequest): GameSnapshot {
    if (request.ownerId !== this.controllerId) throw new HttpError(409, t.gameConflict);
    // The creator's private owner ID authorizes the first claim, including a lost create response.
    if (
      this.controllerEpoch === 0 &&
      this.screenId === undefined &&
      request.epoch === 0 &&
      request.screenId &&
      (request.recoveryId === undefined || request.recoveryId === this.controllerRecoveryId)
    ) {
      this.screenId = request.screenId;
      this.acquisitionEpoch = 0;
      this.claimedAt = Date.now();
      return this.snapshot();
    }
    if (
      request.recoveryId === this.controllerRecoveryId &&
      request.connectionId !== undefined &&
      request.connectionId === this.controllerConnectionId &&
      request.epoch <= this.controllerEpoch
    )
      request = { ...request, epoch: this.controllerEpoch };
    return this.claim(request);
  }
  // Live infos belong to the current interaction; reset them on turn or game switches.
  // Annotation updates must not clear them, so pruning is driven by the interaction ID.
  private pruneLiveInfos(): void {
    const interactionId = this.core.interactionId;
    for (const [key, entry] of this.infos) {
      if (entry.searchId !== interactionId) this.infos.delete(key);
    }
  }
  private publish(): void {
    this.annotationsDirty = false;
    ++this.revision;
    ++this.recordRevision;
    try {
      const snapshot = this.snapshot();
      if (
        !this.terminal &&
        this.core.isActive &&
        Buffer.byteLength(JSON.stringify(snapshot.record)) > MAX_GAME_SNAPSHOT_BYTES - 256 * 1024
      ) {
        this.fail(new Error("Game snapshot limit reached"), "capacity");
        return;
      }
      this.controller?.send({ type: "snapshot", value: snapshot });
    } catch (error) {
      this.fail(error, "capacity");
    }
  }

  connect(
    controllerId: string,
    send: (frame: GameFrame) => void,
    close: (code?: number) => void = () => {},
    connection?: GameConnection,
  ): { epoch: number; heartbeat: () => void; disconnect: () => void } {
    if (
      controllerId !== this.controllerId ||
      !connection?.screenId ||
      connection.recoveryId !== this.controllerRecoveryId
    )
      throw new HttpError(409, t.gameConflict);
    if (this.attachment().attached && this.screenId && connection.screenId !== this.screenId)
      throw new HttpError(423, t.gameConflict);
    // A retry may have missed the epoch assigned to its own previous connection.
    if (
      connection &&
      (connection.controllerEpoch > this.controllerEpoch ||
        (connection.controllerEpoch !== this.controllerEpoch &&
          connection.connectionId !== this.controllerConnectionId))
    )
      throw new HttpError(409, t.gameConflict);
    this.expireDetached();
    const previous = this.controller;
    this.controller = undefined;
    this.core.setConnected(false);
    this.acquisitionEpoch ??= this.controllerEpoch;
    const epoch = ++this.controllerEpoch;
    this.controllerConnectionId = connection?.connectionId;
    this.screenId = connection?.screenId;
    this.controller = { epoch, lastSeen: Date.now(), send, close };
    this.detachedSince = undefined;
    previous?.close(4001);
    this.publish();
    return {
      epoch,
      heartbeat: () => {
        if (this.controller?.epoch === epoch) this.controller.lastSeen = Date.now();
      },
      disconnect: () => this.disconnect(epoch),
    };
  }
  private disconnect(epoch: number): void {
    if (this.controller?.epoch !== epoch) return;
    this.controller = undefined;
    this.claimedAt = 0;
    this.detachedSince = this.now();
    this.core.setConnected(false);
  }

  attachment(): JobAttachmentState {
    return {
      epoch: this.controllerEpoch,
      attached: !!this.controller || Date.now() - this.claimedAt < GAME_CONTROLLER_TIMEOUT_MS,
      generation: this.controllerGeneration,
    };
  }

  attach(request: JobAttachRequest): GameSnapshot {
    if (
      this.request.settings.black.uri === ES_HUMAN ||
      this.request.settings.white.uri === ES_HUMAN
    )
      throw new HttpError(400, t.gameInvalid);
    return this.claim(request);
  }
  private claim(request: JobAttachRequest): GameSnapshot {
    const transition = claimJobControl(this.control(), request);
    if (transition === "retry") {
      this.claimedAt = Date.now();
      return this.snapshot();
    }
    const previous = this.controller;
    this.controller = undefined;
    this.core.setConnected(false);
    this.controllerId = request.ownerId;
    if (transition === "acquire") {
      this.controllerRecoveryId = randomUUID();
      ++this.controllerGeneration;
    }
    this.acquisitionEpoch = request.epoch;
    ++this.controllerEpoch;
    this.controllerConnectionId = undefined;
    this.screenId = request.screenId;
    this.claimedAt = Date.now();
    this.detachedSince = this.now();
    previous?.close(4001);
    return this.snapshot();
  }
  detach(binding: JobBinding): void {
    if (
      this.request.settings.black.uri === ES_HUMAN ||
      this.request.settings.white.uri === ES_HUMAN
    )
      throw new HttpError(400, t.gameInvalid);
    if (!isCurrentJobBinding(this.control(), binding)) return;
    const previous = this.controller;
    if (previous) this.disconnect(previous.epoch);
    this.claimedAt = 0;
    this.controllerId = randomUUID();
    this.controllerRecoveryId = randomUUID();
    ++this.controllerGeneration;
    ++this.controllerEpoch;
    previous?.close(4001);
  }

  command(command: GameCommand, authorization?: JobBinding): Promise<GameSnapshot> {
    if (command.serverInstanceId !== this.request.serverInstanceId)
      throw new HttpError(410, t.gameSessionExpired);
    if (command.controllerId !== this.controllerId) throw new HttpError(409, t.gameConflict);
    const authorize = () =>
      authorizeJobOperation(
        this.control(),
        {
          ownerId: command.controllerId,
          epoch: command.controllerEpoch,
          recoveryId: command.recoveryId,
          screenId: command.screenId,
        },
        authorization,
      );
    const response = () => {
      authorize();
      return this.snapshot();
    };
    authorize();
    const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const previous = this.commands.get(command.requestId);
    if (previous) {
      if (previous.hash !== hash) throw new HttpError(409, t.gameConflict);
      return previous.result.then(response);
    }
    if (!this.controller || command.controllerEpoch > this.controller.epoch)
      throw new HttpError(409, t.gameConflict);
    if (this.commands.size >= 10_000) throw new HttpError(503, t.gameCapacity);
    const result = Promise.resolve().then(async () => {
      authorize();
      if (!this.controller) throw new HttpError(409, t.gameConflict);
      if (
        !["interrupt", "resume"].includes(command.action) &&
        (command.gameId !== this.gameId ||
          command.interactionId !== this.core.interactionId ||
          this.terminal)
      )
        throw new HttpError(409, t.gameConflict);
      if (
        ["move", "resign", "declare"].includes(command.action) &&
        (!this.core.isHumanTurn || !this.core.isActive)
      )
        throw new HttpError(409, t.gameConflict);
      switch (command.action) {
        case "move":
          try {
            this.core.humanMove(command.move!);
          } catch {
            throw new HttpError(400, t.gameInvalid);
          }
          break;
        case "resign":
          this.core.resign();
          break;
        case "declare":
          this.core.declareWin();
          break;
        case "takeback":
          if (!this.core.canTakeback) throw new HttpError(409, t.gameConflict);
          await this.core.takeback();
          break;
        case "interrupt":
          this.abort.abort();
          this.core.stop();
          break;
        case "resume":
          this.core.setConnected(true);
          this.core.resume();
          break;
        case "annotate": {
          if (!this.annotate(command)) throw new HttpError(409, t.gameConflict);
          break;
        }
      }
      this.publish();
    });
    void result.catch(() => {});
    const entry = { hash, result, state: "pending" as "pending" | "accepted" | "rejected" };
    this.commands.set(command.requestId, entry);
    void result.then(
      () => {
        entry.state = "accepted";
      },
      () => {
        entry.state = "rejected";
      },
    );
    return result.then(response);
  }

  commandOutcome(id: string): { state: "unknown" | "pending" | "accepted" | "rejected" } {
    const command = this.commands.get(id);
    if (!command) return { state: "unknown" };
    return { state: command.state };
  }

  annotate(command: GameCommand): boolean {
    const annotation = command.annotation;
    if (
      command.action !== "annotate" ||
      !annotation ||
      command.serverInstanceId !== this.request.serverInstanceId ||
      command.controllerId !== this.controllerId ||
      command.screenId !== this.screenId ||
      command.controllerEpoch !== this.controller?.epoch ||
      command.gameId !== this.gameId ||
      command.interactionId !== this.core.interactionId ||
      !this.core.isActive ||
      this.indexed().get(command.nodeId!) !== this.records.record.current ||
      annotation.info.usi !== this.records.record.usi
    )
      return false;
    const info = restoreSearchInfo(annotation.info);
    if (info.pv) {
      const pv = parseUSIPV(
        this.records.record.position,
        info.pv.map((move) => move.usi),
      );
      if (pv.length !== info.pv.length) return false;
      info.pv = pv;
    }
    const data = (this.records.record.current.customData ?? {}) as RecordCustomData;
    if ((info.depth ?? 0) >= (data[annotation.slot]?.depth ?? 0)) {
      this.records.record.current.customData = { ...data, [annotation.slot]: info };
      this.annotationsDirty = true;
    }
    return true;
  }

  private async saveFinishedRecord(): Promise<void> {
    const source = this.source();
    const summary: GameRecordSummary = { gameId: this.gameId, state: "unsaved" };
    this.summaries.push(summary);
    if (this.core.settings.enableAutoSave) {
      try {
        summary.path = await (this.deps.saveRecord ?? saveGameRecord)(
          source,
          this.request.options.save,
          this.gameId,
        );
        summary.state = "saved";
      } catch (error) {
        console.error("Game save failed", error);
        summary.state = "failed";
        this.error ??= "save";
      }
    }
    try {
      if (summary.state === "saved") {
        await (this.deps.addHistory ?? addHistory)("server://" + summary.path);
      } else {
        await (this.deps.saveBackup ?? saveBackup)(
          exportKIF(restoreRecord(source).record, {
            returnCode: this.request.options.save.returnCode,
          }),
        );
      }
    } catch (error) {
      console.error("Game history failed", error);
      summary.state = "failed";
      this.error ??= "save";
    }
    this.publish();
  }
  private fail(error: unknown, kind: GameError = "engine"): void {
    console.error(`Game ${this.id} failed`, error);
    if (this.error && this.error !== "save") return;
    this.error = kind;
    this.abort.abort();
    this.core.stop();
  }
  private finish(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.endedAt = Date.now();
    this.blackClock.pause();
    this.whiteClock.pause();
    // Engine cleanup has converged at this point in every terminal path.
    this.resourceLease?.release();
    this.resourceLease = undefined;
    this.publish();
    this.complete();
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.abort.abort();
      this.core.stop();
      await this.completion;
      this.dispose();
    })());
  }
  dispose(): void {
    clearInterval(this.timer);
    this.controller?.close();
    this.controller = undefined;
  }
}
