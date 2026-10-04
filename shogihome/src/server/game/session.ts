import { createHash } from "node:crypto";
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
} from "@/common/game/protocol";
import {
  restoreRecord,
  snapshotRecord,
  indexRecordNodes,
  restoreSearchInfo,
  type RecordSnapshot,
} from "@/common/record/snapshot";
import { ES_HUMAN } from "@/common/uri";
import { gameTexts } from "@/common/i18n/game";
import { fetchEngineConfigs, toLanEngineInfo } from "@/server/engine/list";
import { InternalEngine, type GameEngine } from "@/server/engine/internal";
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

export const GAME_HEARTBEAT_MS = 5000;
export const GAME_CONTROLLER_TIMEOUT_MS = 30_000;
export const MAX_GAME_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type GameDependencies = {
  createEngine?: () => GameEngine;
  resolveEngine?: (id: string) => Promise<EngineConfig>;
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

export class GameSession {
  private readonly records: GameRecord;
  private readonly blackClock: Clock;
  private readonly whiteClock: Clock;
  private readonly core: GameController;
  private readonly abort = new AbortController();
  private readonly nodeIds = new WeakMap<ImmutableNode, string>();
  private readonly issuedIds = new Set<string>();
  private nextNodeId = 0;
  private revision = 0;
  private recordRevision = 0;
  private sampleId = 0;
  private lastMoveId = 0;
  private controllerEpoch = 0;
  private controller?: {
    epoch: number;
    lastSeen: number;
    send: (frame: GameFrame) => void;
    close: (code?: number) => void;
  };
  private error?: GameError;
  private lastResult?: SpecialMoveType;
  private terminal = false;
  private summaries: GameRecordSummary[] = [];
  private commands = new Map<string, { hash: string; result: Promise<void> }>();
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
      const controller = this.controller;
      if (!controller) return;
      if (Date.now() - controller.lastSeen >= GAME_CONTROLLER_TIMEOUT_MS) {
        this.disconnect(controller.epoch);
        controller.close(1013);
      } else {
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

  private async run(): Promise<void> {
    if (this.abort.signal.aborted) {
      this.finish();
      return;
    }
    try {
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
              const color = this.records.record.position.color;
              const key = `${color}:${info.multipv ?? 1}`;
              if (!this.infos.has(key) && this.infos.size >= 32) return;
              this.infos.set(key, {
                color,
                name: config.name,
                position,
                searchId: this.core.interactionId,
                info,
              });
            },
          );
          try {
            await player.launch(
              config,
              this.request.options.engineTimeoutSeconds,
              this.abort.signal,
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
        this.error = "engine";
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
  snapshot(): GameSnapshot {
    return {
      sessionId: this.id,
      requestId: this.request.requestId,
      serverInstanceId: this.request.serverInstanceId,
      controllerEpoch: this.controllerEpoch,
      revision: this.revision,
      recordRevision: this.recordRevision,
      sampleId: ++this.sampleId,
      gameId: this.gameId,
      gameNumber: this.core.gameNumber,
      interactionId: this.core.interactionId,
      state: this.terminal
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
                : "preparing",
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
  private publish(): void {
    this.annotationsDirty = false;
    ++this.revision;
    ++this.recordRevision;
    this.infos.clear();
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
  ): { epoch: number; heartbeat: () => void; disconnect: () => void } {
    if (controllerId !== this.request.controllerId) throw new HttpError(403, gameTexts().invalid);
    const previous = this.controller;
    this.controller = undefined;
    this.core.setConnected(false);
    const epoch = ++this.controllerEpoch;
    this.controller = { epoch, lastSeen: Date.now(), send, close };
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
    this.core.setConnected(false);
  }

  command(command: GameCommand): Promise<GameSnapshot> {
    if (command.serverInstanceId !== this.request.serverInstanceId)
      throw new HttpError(410, gameTexts().expired);
    if (
      command.controllerId !== this.request.controllerId ||
      command.controllerEpoch !== this.controller?.epoch
    )
      throw new HttpError(409, gameTexts().conflict);
    const hash = createHash("sha256")
      .update(JSON.stringify({ ...command, controllerEpoch: 0 }))
      .digest("hex");
    const previous = this.commands.get(command.requestId);
    if (previous) {
      if (previous.hash !== hash) throw new HttpError(409, gameTexts().conflict);
      return previous.result.then(() => this.snapshot());
    }
    if (this.commands.size >= 10_000) throw new HttpError(503, gameTexts().capacity);
    const result = Promise.resolve().then(async () => {
      if (command.controllerEpoch !== this.controller?.epoch)
        throw new HttpError(409, gameTexts().conflict);
      if (
        !["interrupt", "resume"].includes(command.action) &&
        (command.gameId !== this.gameId ||
          command.interactionId !== this.core.interactionId ||
          this.terminal)
      )
        throw new HttpError(409, gameTexts().conflict);
      if (
        ["move", "resign", "declare"].includes(command.action) &&
        (!this.core.isHumanTurn || !this.core.isActive)
      )
        throw new HttpError(409, gameTexts().conflict);
      switch (command.action) {
        case "move":
          try {
            this.core.humanMove(command.move!);
          } catch {
            throw new HttpError(400, gameTexts().invalid);
          }
          break;
        case "resign":
          this.core.resign();
          break;
        case "declare":
          this.core.declareWin();
          break;
        case "takeback":
          if (!this.core.canTakeback) throw new HttpError(409, gameTexts().conflict);
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
          if (!this.annotate(command)) throw new HttpError(409, gameTexts().conflict);
          break;
        }
      }
      this.publish();
    });
    void result.catch(() => {});
    this.commands.set(command.requestId, { hash, result });
    return result.then(() => this.snapshot());
  }

  annotate(command: GameCommand): boolean {
    const annotation = command.annotation;
    if (
      command.action !== "annotate" ||
      !annotation ||
      command.serverInstanceId !== this.request.serverInstanceId ||
      command.controllerId !== this.request.controllerId ||
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
    this.publish();
    this.complete();
  }
  async close(): Promise<void> {
    this.abort.abort();
    this.core.stop();
    await this.completion;
    clearInterval(this.timer);
    this.controller?.close();
    this.controller = undefined;
  }
  dispose(): void {
    clearInterval(this.timer);
    this.controller?.close();
    this.controller = undefined;
  }
}
