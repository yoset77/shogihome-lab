import { Color, Move, SpecialMoveType } from "tsshogi";
import { defaultGameSettings, type GameSettings } from "@/common/settings/game";
import { newGameResults, type GameResults } from "@/common/game/results";
import {
  decodeGameRequest,
  decodeGameCommand,
  decodeGameFrame,
  isGameTerminal,
  type GameSessionRequest,
  type GameSnapshot,
  type GameCommand,
  type GameCommandAction,
  type GameFrame,
} from "@/common/game/protocol";
import { snapshotRecord, type RecordSnapshot } from "@/common/record/snapshot";
import { jobRecordContent as durableContent } from "./job_record";
import { object, identifier, text, counter } from "@/common/analysis/validation";
import { gameTexts } from "@/common/i18n/game";
import { createGameSessionsClient, type GameSessionsClient } from "@/renderer/api/game_sessions";
import { ApiResponseError, isRequestTimeoutError } from "@/renderer/api/client";
import { generateSessionId } from "@/renderer/helpers/unique";
import {
  dispatchUSIInfoUpdate,
  setInfoSessionActive,
  triggerOnStartSearch,
} from "@/renderer/players/usi_events";
import type { SearchInfo } from "@/common/record/types";
import { SearchInfoSenderType } from "@/common/record/types";
import { encodeSearchInfo } from "@/common/record/snapshot";
import { RecordManager } from "./record";
import { GameClockDisplay } from "./game_clock";
import { JobStorage } from "./job_storage";
import {
  readJobAttachRequest,
  readJobBinding,
  type JobBinding,
  type JobAttachRequest,
  type JobSummary,
} from "@/common/jobs/types";
import { jobTexts } from "@/common/i18n/jobs";
import { useAppSettings } from "./settings";
import { clearURLParams, flushRecordForWebApp } from "./webapp";
import { ConnectionNotification } from "@/renderer/helpers/connection_notification";
import { ES_HUMAN } from "@/common/uri";

export { calculateGameStatistics } from "@/common/game/results";
export type { GameResults, GameStatistics } from "@/common/game/results";
const STORAGE_KEY = "shogihome-game-session";
const MONITOR_IDS = { [Color.BLACK]: 200200, [Color.WHITE]: 200201 };
const SCREEN_ID = generateSessionId();
type Reference = {
  requestId: string;
  serverInstanceId: string;
  controllerId: string;
  connectionId?: string;
  controllerEpoch?: number;
  recoveryId?: string;
  sessionId?: string;
  content: string;
  pending: GameCommand[];
  stopRequested?: boolean;
  pendingAttach?: JobAttachRequest;
  pendingDetach?: JobBinding;
};
type Handlers = {
  gameEnd: (results: GameResults, result: SpecialMoveType) => void;
  flipBoard: (flip: boolean) => void;
  pieceBeat: () => void;
  beepShort: () => void;
  beepUnlimited: () => void;
  stopBeep: () => void;
  resetMonitor: (sessionId: number) => void;
  error: (error: unknown) => void;
  status: (status: GameSnapshot | null) => void;
};

function readReference(raw: string | null): Reference | undefined {
  try {
    if (!raw) return;
    const input = object(JSON.parse(raw));
    const pending = Array.isArray(input.pending)
      ? input.pending.map((value) => {
          const decoded = decodeGameCommand(value);
          if (!decoded.ok) throw new Error(decoded.error);
          return decoded.value;
        })
      : [];
    if (pending.length > 8) return;
    return {
      requestId: identifier(input.requestId),
      serverInstanceId: identifier(input.serverInstanceId),
      controllerId: identifier(input.controllerId),
      ...(input.recoveryId === undefined ? {} : { recoveryId: identifier(input.recoveryId) }),
      ...(input.connectionId === undefined ? {} : { connectionId: identifier(input.connectionId) }),
      ...(input.controllerEpoch === undefined
        ? {}
        : { controllerEpoch: counter(input.controllerEpoch) }),
      ...(input.sessionId === undefined ? {} : { sessionId: identifier(input.sessionId) }),
      content: text(input.content, 20 * 1024 * 1024),
      pending,
      stopRequested: input.stopRequested === true,
      ...(input.pendingAttach === undefined
        ? {}
        : { pendingAttach: readJobAttachRequest(input.pendingAttach) }),
      ...(input.pendingDetach === undefined
        ? {}
        : { pendingDetach: readJobBinding(input.pendingDetach) }),
    };
  } catch {
    return;
  }
}
const storage = new JobStorage(
  "game",
  STORAGE_KEY,
  readReference,
  (ref) => ({ ...ref, content: "" }),
  (ref) => [
    ...(!ref.sessionId
      ? [
          {
            id: "creation",
            reference: { ...ref, pending: [], stopRequested: undefined, pendingAttach: undefined },
          },
        ]
      : []),
    ...(ref.pendingAttach
      ? [{ id: "attachment", reference: { ...ref, pending: [], stopRequested: undefined } }]
      : []),
    ...(ref.stopRequested
      ? [{ id: "stop", reference: { ...ref, pending: [], pendingAttach: undefined } }]
      : []),
    ...(ref.pendingDetach
      ? [
          {
            id: "detach",
            reference: { ...ref, pending: [], pendingAttach: undefined, stopRequested: undefined },
          },
        ]
      : []),
    ...ref.pending.map((command) => ({
      id: command.requestId,
      reference: { ...ref, pending: [command], stopRequested: undefined, pendingAttach: undefined },
    })),
  ],
);
function loadReferences(): Reference[] {
  const ref = storage.load();
  if (!ref) return [];
  const pending = storage
    .journal()
    .filter(
      (value) =>
        value.requestId === ref.requestId &&
        value.serverInstanceId === ref.serverInstanceId &&
        value.controllerId === ref.controllerId,
    );
  return [
    {
      ...ref,
      pending: pending.flatMap((value) => value.pending),
      stopRequested: pending.some((value) => value.stopRequested),
      pendingAttach: pending.find((value) => value.pendingAttach)?.pendingAttach,
    },
  ];
}
function forgetReference(ref: Reference): void {
  storage.detach(ref);
  storage.forgetJournal(ref);
}

export class GameManager {
  private reference?: Reference;
  private background = false;
  private pendingRequest?: GameSessionRequest;
  private _status?: GameSnapshot;
  private active = false;
  private socket?: WebSocket;
  private socketReady = false;
  private generation = 0;
  private connectionId = generateSessionId();
  // Only our own connection may advance the epoch used for automatic reconnects.
  private controllerEpoch?: number;
  private lifecycle = 0;
  private bindingToken?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private retryMs = 1000;
  private retryNotBefore = 0;
  private synchronizing = false;
  private finishing = false;
  private finished = false;
  private lastMoveId = 0;
  private lastSampleId = 0;
  private lastFrameAt = 0;
  private lastSearch = new Map<Color, number>();
  private sending = new Set<string>();
  private annotationTimes = new Map<string, number>();
  private warned = new Set<string>();
  // Remaining seconds last notified per clock; the display value is interpolated.
  private notifiedSeconds = new Map<GameClockDisplay, number>();
  private readonly connection = new ConnectionNotification("game-connection");
  private handlers: Handlers = {
    gameEnd: () => {},
    flipBoard: () => {},
    pieceBeat: () => {},
    beepShort: () => {},
    beepUnlimited: () => {},
    stopBeep: () => {},
    resetMonitor: () => {},
    error: () => {},
    status: () => {},
  };

  constructor(
    private readonly recordManager: RecordManager,
    readonly blackClock = new GameClockDisplay(),
    readonly whiteClock = new GameClockDisplay(),
    private readonly client: GameSessionsClient = createGameSessionsClient(),
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}
  on<K extends keyof Handlers>(event: K, handler: Handlers[K]): this {
    this.handlers[event] = handler;
    return this;
  }
  get settings(): GameSettings {
    return this._status?.settings ?? defaultGameSettings();
  }
  get results(): GameResults {
    return this._status?.results ?? newGameResults("", "");
  }
  get status(): GameSnapshot | undefined {
    return this._status;
  }
  get isActive(): boolean {
    return this.active;
  }
  get hasRetainedSession(): boolean {
    return this.active ? !!this.reference : loadReferences().length > 0;
  }
  get reconnecting(): boolean {
    return this.active && !this.socketReady;
  }
  get isPaused(): boolean {
    return this._status?.state === "paused";
  }
  get supportsTakeback(): boolean {
    return !!this._status?.supportsTakeback;
  }
  get isTakingBack(): boolean {
    return (
      this._status?.state === "takingBack" ||
      !!this.reference?.pending.some((command) => command.action === "takeback")
    );
  }
  get canMove(): boolean {
    return (
      this.active && this.socketReady && !!this._status?.canMove && !this.reference?.pending.length
    );
  }
  get canTakeback(): boolean {
    return (
      this.active &&
      this.socketReady &&
      !!this._status?.canTakeback &&
      !this.reference?.pending.length
    );
  }
  get interactionId(): number {
    return this._status?.interactionId ?? 0;
  }
  async reconcilePending(): Promise<void> {
    for (const ref of storage.journal()) {
      try {
        const caps = await this.client.capabilities();
        if (caps.serverInstanceId !== ref.serverInstanceId) {
          storage.forgetJournal(ref);
          continue;
        }
        const status = ref.sessionId
          ? await this.client.snapshot(ref.sessionId)
          : await this.client.byRequest(ref.requestId);
        storage.forgetOperation(ref, "creation");
        if (
          ref.pendingDetach &&
          (status.controllerEpoch !== ref.pendingDetach.epoch ||
            status.controllerOwnerId !== ref.pendingDetach.ownerId)
        )
          storage.forgetOperation(ref, "detach");
        if (
          ref.pendingAttach &&
          ((status.controllerOwnerId !== ref.controllerId &&
            status.controllerEpoch > ref.pendingAttach.epoch) ||
            isGameTerminal(status.state))
        )
          storage.forgetOperation(ref, "attachment");
        if (
          ref.stopRequested &&
          (isGameTerminal(status.state) ||
            (ref.recoveryId
              ? status.controllerRecoveryId !== ref.recoveryId
              : ref.controllerEpoch !== undefined && status.controllerEpoch > ref.controllerEpoch))
        )
          storage.forgetOperation(ref, "stop");
        for (const command of ref.pending) {
          const outcome = await this.client.commandOutcome(status.sessionId, command.requestId);
          if (
            ["accepted", "rejected"].includes(outcome.state) ||
            isGameTerminal(status.state) ||
            (command.recoveryId
              ? status.controllerRecoveryId !== command.recoveryId
              : status.controllerEpoch > command.controllerEpoch)
          )
            storage.forgetOperation(ref, command.requestId);
        }
      } catch (error) {
        if (error instanceof ApiResponseError && error.status === 410) storage.forgetJournal(ref);
        else if (!this.transient(error)) throw error;
      }
    }
  }
  private persist(): void {
    const ref = this.reference;
    if (!ref) return;
    if (!ref.sessionId || ref.pending.length || ref.stopRequested || ref.pendingAttach)
      storage.writeJournal(ref);
    else storage.forgetJournal(ref);
    if (!this.background)
      storage.save({ ...ref, pending: [], stopRequested: undefined, pendingAttach: undefined });
  }
  private transient(error: unknown): boolean {
    return (
      error instanceof TypeError ||
      isRequestTimeoutError(error) ||
      (error instanceof ApiResponseError && (error.status === 429 || error.status >= 500))
    );
  }
  private backoff(error: unknown): void {
    this.connection.lost();
    const retry = error instanceof ApiResponseError ? error.retryAfterMs : undefined;
    this.retryNotBefore = Date.now() + Math.max(this.retryMs, retry ?? 0);
    this.retryMs = Math.min(30_000, this.retryMs * 2);
    this.detach();
  }
  private schedule(): void {
    clearTimeout(this.reconnectTimer);
    if (!this.reference) return;
    this.reconnectTimer = setTimeout(
      () => {
        void this.synchronize();
      },
      Math.max(1000, this.retryNotBefore - Date.now()),
    );
  }
  private bind(token: string): RecordSnapshot {
    const source = this.recordManager.beginGame(token);
    this.bindingToken = token;
    this.active = true;
    ++this.lifecycle;
    this.finished = false;
    this.connection.reset();
    this._status = undefined;
    this.connectionId = generateSessionId();
    this.controllerEpoch = undefined;
    this.lastMoveId = 0;
    this.lastSampleId = 0;
    this.warned.clear();
    this.notifiedSeconds.clear();
    this.resetMonitors();
    this.handlers.status(null);
    return source;
  }
  private resetMonitors(): void {
    this.lastSearch.clear();
    for (const id of Object.values(MONITOR_IDS)) {
      setInfoSessionActive(id, false);
      this.handlers.resetMonitor(id);
    }
  }
  async start(settings: GameSettings, background = false): Promise<void> {
    if (this.active || this.hasRetainedSession)
      throw new Error(gameTexts(useAppSettings().language).capacity);
    if (background && [settings.black.uri, settings.white.uri].includes("es://human"))
      throw new Error(gameTexts(useAppSettings().language).invalid);
    this.background = background;
    const requestId = generateSessionId();
    const source = this.bind(requestId);
    const lifecycle = this.lifecycle;
    let posted = false;
    try {
      const app = useAppSettings();
      const caps = await this.client.capabilities();
      if (lifecycle !== this.lifecycle) return;
      const input: GameSessionRequest = {
        requestId,
        serverInstanceId: caps.serverInstanceId,
        controllerId: generateSessionId(),
        source,
        settings,
        options: {
          engineTimeoutSeconds: app.engineTimeoutSeconds,
          commentFormat: app.searchCommentFormat,
          language: app.language,
          save: {
            directory: app.autoSaveDirectory,
            template: app.recordFileNameTemplate,
            format: app.defaultRecordFileFormat,
            returnCode: app.returnCode,
            useCSAV3: app.useCSAV3,
            useUTF8ForKifAndKi2: app.useUTF8ForKifAndKi2,
          },
        },
      };
      const decoded = decodeGameRequest(JSON.parse(JSON.stringify(input)));
      if (!decoded.ok) throw new Error(gameTexts(app.language).invalid);
      if (new TextEncoder().encode(JSON.stringify(decoded.value)).length > caps.maxInputBytes)
        throw new Error(gameTexts(app.language).capacity);
      await this.recordManager.saveBackup();
      if (lifecycle !== this.lifecycle) return;
      if (loadReferences().length) throw new Error(gameTexts(app.language).capacity);
      this.reference = {
        requestId,
        serverInstanceId: caps.serverInstanceId,
        controllerId: input.controllerId,
        content: durableContent(source),
        pending: [],
      };
      this.persist();
      this.pendingRequest = decoded.value;
      posted = true;
      try {
        const snapshot = await this.client.create(decoded.value);
        if (lifecycle !== this.lifecycle) return;
        if (background) {
          this.reference.sessionId = snapshot.sessionId;
          this.persist();
        } else this.accept(snapshot, true);
        this.pendingRequest = undefined;
        if (!background) this.connect();
      } catch (error) {
        if (lifecycle !== this.lifecycle) return;
        if (!this.transient(error) || (error instanceof ApiResponseError && error.status === 503))
          throw error;
        this.backoff(error);
        this.schedule();
      }
      if (background) {
        this.recordManager.endGame(requestId);
        this.bindingToken = undefined;
        this.active = false;
        this.handlers.status(null);
        if (this.reference?.sessionId) this.reference = undefined;
      }
    } catch (error) {
      if (lifecycle !== this.lifecycle) return;
      const rejected =
        error instanceof ApiResponseError && [400, 403, 409, 410, 413, 503].includes(error.status);
      this.release(requestId, !posted || rejected);
      throw error;
    }
  }
  async resume(confirmRecovery: () => Promise<boolean>): Promise<boolean> {
    if (this.active) return false;
    const references = loadReferences();
    this.background = false;
    this.reference = references[0];
    for (const [index, ref] of references.entries()) {
      const local = durableContent(snapshotRecord(this.recordManager.record));
      if (local !== ref.content && !(await confirmRecovery())) return false;
      await this.recordManager.saveBackup();
      if (durableContent(snapshotRecord(this.recordManager.record)) !== local)
        throw new Error(gameTexts().conflict);
      this.reference = ref;
      this.bind(ref.requestId);
      this.controllerEpoch = ref.controllerEpoch;
      await this.synchronize(!ref.sessionId && index < references.length - 1);
      if (this.active || this.finished) return true;
      if (this.reference) return false;
    }
    return false;
  }
  private async synchronize(skipMissingRequest = false): Promise<void> {
    const ref = this.reference;
    if (!ref || this.synchronizing) return;
    if (Date.now() < this.retryNotBefore) {
      this.schedule();
      return;
    }
    this.synchronizing = true;
    const lifecycle = this.lifecycle;
    try {
      const caps = await this.client.capabilities();
      if (lifecycle !== this.lifecycle || this.reference !== ref) return;
      if (caps.serverInstanceId !== ref.serverInstanceId)
        throw new ApiResponseError(410, gameTexts().expired);
      let snapshot: GameSnapshot;
      try {
        snapshot = ref.sessionId
          ? ref.pendingAttach
            ? await this.client.attach(ref.sessionId, ref.pendingAttach)
            : await this.client.snapshot(ref.sessionId)
          : await this.client.byRequest(ref.requestId);
      } catch (error) {
        if (lifecycle !== this.lifecycle || this.reference !== ref) return;
        if (!(error instanceof ApiResponseError && error.status === 410 && this.pendingRequest))
          throw error;
        snapshot = await this.client.create(this.pendingRequest);
      }
      this.pendingRequest = undefined;
      if (lifecycle !== this.lifecycle || this.reference !== ref) return;
      if (ref.pendingAttach) {
        ref.pendingAttach = undefined;
        ref.controllerEpoch = snapshot.controllerEpoch;
        ref.recoveryId = snapshot.controllerRecoveryId;
        storage.forgetOperation(ref, "attachment");
        this.persist();
      }
      if (this.background) {
        ref.sessionId = snapshot.sessionId;
        this.persist();
        this.reference = undefined;
        return;
      }
      if (
        (ref.recoveryId !== undefined && snapshot.controllerRecoveryId !== ref.recoveryId) ||
        (ref.controllerEpoch !== undefined &&
          snapshot.controllerEpoch > ref.controllerEpoch &&
          snapshot.controllerConnectionId !== ref.connectionId)
      )
        throw new ApiResponseError(409, jobTexts(useAppSettings().language).transferred);
      this.controllerEpoch = snapshot.controllerEpoch;
      this.accept(snapshot, true);
      this.retryMs = 1000;
      this.retryNotBefore = 0;
      this.connect();
    } catch (error) {
      if (lifecycle !== this.lifecycle || this.reference !== ref) return;
      if (this.transient(error)) {
        this.backoff(error);
        this.schedule();
      } else {
        if (error instanceof ApiResponseError && error.status === 409) storage.detach(ref);
        this.release(ref.requestId, error instanceof ApiResponseError && error.status === 410);
        if (!(skipMissingRequest && error instanceof ApiResponseError && error.status === 410))
          this.handlers.error(error);
      }
    } finally {
      this.synchronizing = false;
    }
  }
  get canDetach(): boolean {
    return (
      this.active &&
      (!!this.reference?.pendingAttach ||
        (!!this._status &&
          ![this._status.settings.black.uri, this._status.settings.white.uri].includes(
            "es://human",
          )))
    );
  }

  detachJob(): void {
    const ref = this.reference;
    const status = this._status;
    if (!ref || !this.canDetach) return;
    const epoch =
      status?.controllerEpoch ?? (ref.pendingAttach ? ref.pendingAttach.epoch + 1 : undefined);
    if (ref.sessionId && epoch !== undefined)
      storage.writeJournal({ ...ref, pendingDetach: { ownerId: ref.controllerId, epoch } });
    storage.detach(ref);
    this.release(ref.requestId, false);
    this.reference = undefined;
    this.pendingRequest = undefined;
    if (ref.sessionId && epoch !== undefined)
      void this.client
        .detach(ref.sessionId, { ownerId: ref.controllerId, epoch })
        .then(() => storage.forgetOperation(ref, "detach"))
        .catch((error) => this.handlers.error(error));
  }

  async attach(
    job: JobSummary,
    confirmRecovery: () => Promise<boolean>,
    confirmTakeover: () => Promise<boolean>,
  ): Promise<boolean> {
    if (this.active) return false;
    let lifecycle = this.lifecycle;
    if (job.attachment.attached && !(await confirmTakeover())) return false;
    const caps = await this.client.capabilities();
    if (lifecycle !== this.lifecycle) return false;
    if (caps.serverInstanceId !== job.serverInstanceId)
      throw new ApiResponseError(410, gameTexts().expired);
    const preview = await this.client.snapshot(job.id);
    if (lifecycle !== this.lifecycle) return false;
    const local = durableContent(snapshotRecord(this.recordManager.record));
    if (local !== durableContent(preview.record) && !(await confirmRecovery())) return false;
    await this.recordManager.saveBackup();
    if (lifecycle !== this.lifecycle) return false;
    if (durableContent(snapshotRecord(this.recordManager.record)) !== local)
      throw new Error(gameTexts().conflict);
    this.background = false;
    const controllerId = generateSessionId();
    this.reference = {
      requestId: job.requestId,
      serverInstanceId: job.serverInstanceId,
      sessionId: job.id,
      controllerId,
      content: durableContent(snapshotRecord(this.recordManager.record)),
      pending: [],
      pendingAttach: {
        ownerId: controllerId,
        epoch: job.attachment.epoch,
        takeover: job.attachment.attached,
      },
    };
    let snapshot: GameSnapshot | undefined;
    try {
      this.bind(job.requestId);
      lifecycle = this.lifecycle;
      this.persist();
      snapshot = await this.client.attach(job.id, this.reference.pendingAttach!);
      if (lifecycle !== this.lifecycle) {
        void this.client
          .detach(job.id, { ownerId: controllerId, epoch: snapshot.controllerEpoch })
          .catch(() => {});
        return false;
      }
      this.reference.pendingAttach = undefined;
      this.reference.controllerEpoch = snapshot.controllerEpoch;
      this.reference.recoveryId = snapshot.controllerRecoveryId;
      storage.forgetOperation(this.reference, "attachment");
      this.accept(snapshot, true);
      if (this.active) this.connect();
      return true;
    } catch (error) {
      if (lifecycle !== this.lifecycle) return false;
      if (this.transient(error)) {
        this.backoff(error);
        this.schedule();
        return true;
      }
      this.release(job.requestId, true);
      if (snapshot)
        void this.client
          .detach(job.id, { ownerId: controllerId, epoch: snapshot.controllerEpoch })
          .catch(() => {});
      throw error;
    }
  }

  private connect(): void {
    const ref = this.reference;
    if (!ref?.sessionId || this.socket) return;
    const url = new URL(`/ws/game-sessions/${ref.sessionId}`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("serverInstanceId", ref.serverInstanceId);
    url.searchParams.set("controllerId", ref.controllerId);
    this.controllerEpoch ??= this._status!.controllerEpoch;
    url.searchParams.set("connectionId", this.connectionId);
    url.searchParams.set("screenId", SCREEN_ID);
    url.searchParams.set("controllerEpoch", String(this.controllerEpoch));
    const generation = ++this.generation;
    this.lastFrameAt = Date.now();
    const socket = (this.socket = this.createSocket(url.href));
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 5000);
    socket.onmessage = (event) => {
      if (generation !== this.generation || this.socket !== socket) return;
      try {
        if (typeof event.data !== "string" || event.data.length > 32 * 1024 * 1024)
          throw new Error(gameTexts().invalid);
        const decoded = decodeGameFrame(JSON.parse(event.data));
        if (!decoded.ok) throw new Error(gameTexts().invalid);
        // Clock frames cannot complete the initial controller handshake.
        if (this.socketReady || decoded.value.type === "snapshot") this.lastFrameAt = Date.now();
        const initial = !this.socketReady;
        this.frame(decoded.value, initial);
        if (decoded.value.type === "snapshot" && initial && this.reference) {
          this.socketReady = true;
          this.retryMs = 1000;
          this.heartbeat();
          void this.resendPending()
            .then(() => {
              if (this.active && this.socketReady)
                return this.request(this.reference?.stopRequested ? "interrupt" : "resume");
            })
            .then(() => {
              if (generation === this.generation && this.active && this.socketReady)
                this.connection.restored();
            })
            .catch((error) => this.handlers.error(error));
        }
      } catch (error) {
        this.handlers.error(error);
        socket.close();
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.socket = undefined;
      this.socketReady = false;
      this.blackClock.pause();
      this.whiteClock.pause();
      this.handlers.stopBeep();
      clearInterval(this.heartbeatTimer);
      if (event.code === 4001) {
        storage.detach(ref);
        this.release(ref.requestId, false);
        this.handlers.error(new Error(jobTexts(useAppSettings().language).transferred));
      } else if (event.code === 4004) {
        this.release(ref.requestId, true);
        this.handlers.error(new Error(gameTexts().expired));
      } else {
        this.connection.lost();
        this.schedule();
      }
    };
  }
  private heartbeat(): void {
    if (Date.now() - this.lastFrameAt >= 10_000) {
      this.backoff(new TypeError("Game updates timed out"));
      this.blackClock.pause();
      this.whiteClock.pause();
      this.handlers.stopBeep();
      this.schedule();
      return;
    }
    if (this.socketReady && this.socket?.readyState === 1 && this._status)
      this.socket.send(
        JSON.stringify({ type: "heartbeat", controllerEpoch: this._status.controllerEpoch }),
      );
  }
  private frame(frame: GameFrame, initial: boolean): void {
    if (frame.type === "snapshot") {
      this.accept(frame.value, initial);
      return;
    }
    const status = this._status;
    if (
      !status ||
      frame.sessionId !== status.sessionId ||
      frame.serverInstanceId !== status.serverInstanceId
    )
      throw new Error(gameTexts().invalid);
    if (frame.revision > status.revision) {
      void this.synchronize();
      return;
    }
    if (frame.revision < status.revision || frame.sampleId <= this.lastSampleId) return;
    this.lastSampleId = frame.sampleId;
    this.updateClocks(frame.clocks, false);
    for (const live of frame.infos) {
      if (live.position !== this.recordManager.record.usi || live.searchId !== this.interactionId)
        continue;
      const id = MONITOR_IDS[live.color];
      if (this.lastSearch.get(live.color) !== live.searchId) {
        this.lastSearch.set(live.color, live.searchId);
        triggerOnStartSearch(id, this.recordManager.record.position);
      }
      dispatchUSIInfoUpdate(id, this.recordManager.record.position, live.name, live.info);
    }
  }
  private updateClocks(clocks: GameSnapshot["clocks"], silent: boolean): void {
    const active = clocks.black.running
      ? this.blackClock
      : clocks.white.running
        ? this.whiteClock
        : undefined;
    this.blackClock.update(clocks.black);
    this.whiteClock.update(clocks.white);
    if (!active) {
      this.handlers.stopBeep();
      return;
    }
    // The previous display value is already interpolated up to now, so it equals
    // the new sample on synchronized updates. Compare with the last notified
    // second instead to keep the remaining-time warnings working.
    const remaining = active.time || active.byoyomi;
    const last = this.notifiedSeconds.get(active);
    this.notifiedSeconds.set(active, remaining);
    if (!silent && remaining !== last && !(active.time && active.byoyomi)) {
      if (remaining <= 5) this.handlers.beepUnlimited();
      else if (remaining <= 10 || [20, 30, 60].includes(remaining)) this.handlers.beepShort();
    }
  }
  private accept(snapshot: GameSnapshot, silent = false): void {
    const ref = this.reference;
    if (
      !ref ||
      snapshot.requestId !== ref.requestId ||
      snapshot.serverInstanceId !== ref.serverInstanceId ||
      (ref.sessionId && ref.sessionId !== snapshot.sessionId)
    )
      throw new Error(gameTexts().invalid);
    if (
      (snapshot.controllerOwnerId !== undefined &&
        snapshot.controllerOwnerId !== ref.controllerId) ||
      (ref.recoveryId !== undefined && snapshot.controllerRecoveryId !== ref.recoveryId) ||
      (this.controllerEpoch !== undefined &&
        snapshot.controllerEpoch > this.controllerEpoch &&
        snapshot.controllerConnectionId !== this.connectionId)
    )
      throw new ApiResponseError(409, gameTexts().conflict);
    if (
      this._status &&
      (snapshot.revision < this._status.revision ||
        snapshot.controllerEpoch < this._status.controllerEpoch)
    )
      return;
    if (this._status?.revision === snapshot.revision && snapshot.sampleId <= this.lastSampleId)
      return;
    if (this._status && this._status.gameId !== snapshot.gameId) this.resetMonitors();
    for (const color of [Color.BLACK, Color.WHITE])
      setInfoSessionActive(
        MONITOR_IDS[color],
        !isGameTerminal(snapshot.state) && snapshot.settings[color].uri !== ES_HUMAN,
      );
    if (this._status?.interactionId !== snapshot.interactionId) this.annotationTimes.clear();
    if (this.active && (!this._status || snapshot.recordRevision !== this._status.recordRevision)) {
      if (!this.recordManager.applyGameSnapshot(ref.requestId, snapshot.record))
        throw new Error(gameTexts().conflict);
      clearURLParams();
      flushRecordForWebApp(this.recordManager.record);
      ref.content = durableContent(snapshotRecord(this.recordManager.record));
    }
    ref.sessionId = snapshot.sessionId;
    ref.recoveryId = snapshot.controllerRecoveryId;
    if (snapshot.controllerConnectionId === this.connectionId) {
      this.controllerEpoch = snapshot.controllerEpoch;
      ref.connectionId = this.connectionId;
      ref.controllerEpoch = snapshot.controllerEpoch;
    }
    this._status = snapshot;
    this.lastSampleId = Math.max(this.lastSampleId, snapshot.sampleId);
    this.persist();
    this.updateClocks(snapshot.clocks, silent);
    if (
      !silent &&
      snapshot.lastMoveId === this.lastMoveId + 1 &&
      this.recordManager.record.current.move instanceof Move
    )
      this.handlers.pieceBeat();
    this.lastMoveId = snapshot.lastMoveId;
    if (snapshot.settings.humanIsFront) {
      if (
        snapshot.settings.black.uri === "es://human" &&
        snapshot.settings.white.uri !== "es://human"
      )
        this.handlers.flipBoard(false);
      else if (
        snapshot.settings.white.uri === "es://human" &&
        snapshot.settings.black.uri !== "es://human"
      )
        this.handlers.flipBoard(true);
    }
    this.handlers.status(snapshot);
    for (const record of snapshot.records)
      if (record.state === "failed" && !this.warned.has(record.gameId)) {
        this.warned.add(record.gameId);
        this.handlers.error(new Error(gameTexts(useAppSettings().language).save));
      }
    if (isGameTerminal(snapshot.state)) {
      this.finish(snapshot);
    }
  }
  private finish(snapshot: GameSnapshot): void {
    if (this.finishing || this.finished) return;
    this.finishing = true;
    try {
      flushRecordForWebApp(this.recordManager.record);
      const ref = this.reference;
      if (ref) forgetReference(ref);
      this.recordManager.endGame(snapshot.requestId);
      this.bindingToken = undefined;
      this.active = false;
      this.finished = true;
      this.handlers.stopBeep();
      for (const id of Object.values(MONITOR_IDS)) setInfoSessionActive(id, false);
      this.connection.restored();
      this.reference = undefined;
      this.pendingRequest = undefined;
      this.detach();
      if (
        ref?.sessionId &&
        ![snapshot.settings.black.uri, snapshot.settings.white.uri].includes("es://human")
      ) {
        try {
          const binding = { ownerId: ref.controllerId, epoch: snapshot.controllerEpoch };
          storage.writeJournal({
            ...ref,
            pending: [],
            stopRequested: undefined,
            pendingAttach: undefined,
            pendingDetach: binding,
          });
          void this.client
            .detach(ref.sessionId, binding)
            .then(() => storage.forgetOperation(ref, "detach"))
            .catch((error) => this.handlers.error(error));
        } catch (error) {
          this.handlers.error(error);
        }
      }
      if (snapshot.error && snapshot.error !== "save")
        this.handlers.error(new Error(gameTexts(useAppSettings().language)[snapshot.error]));
      this.handlers.gameEnd(snapshot.results, snapshot.lastResult ?? SpecialMoveType.INTERRUPT);
    } finally {
      this.finishing = false;
    }
  }
  private detach(): void {
    ++this.generation;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.socket?.close();
    this.socket = undefined;
    this.socketReady = false;
  }
  private release(token: string, clear: boolean): void {
    if (clear && this.reference?.requestId === token) {
      try {
        forgetReference(this.reference);
      } catch (error) {
        clear = false;
        this.handlers.error(error);
      }
    }
    ++this.lifecycle;
    this.detach();
    this.recordManager.endGame(token);
    this.bindingToken = undefined;
    this.active = false;
    this.connection.reset();
    this.blackClock.pause();
    this.whiteClock.pause();
    this.handlers.stopBeep();
    for (const id of Object.values(MONITOR_IDS)) setInfoSessionActive(id, false);
    if (clear) {
      this.reference = undefined;
      this.pendingRequest = undefined;
    }
    this.handlers.status(null);
  }
  private async send(command: GameCommand): Promise<void> {
    const ref = this.reference,
      status = this._status;
    if (!ref?.sessionId || !status || !this.socketReady || this.sending.has(command.requestId))
      return;
    this.persist();
    this.sending.add(command.requestId);
    const lifecycle = this.lifecycle;
    try {
      const response = await this.client.command(ref.sessionId, command);
      if (this.reference !== ref || lifecycle !== this.lifecycle) return;
      ref.pending = ref.pending.filter((item) => item.requestId !== command.requestId);
      if (command.action === "interrupt") ref.stopRequested = false;
      storage.forgetOperation(ref, command.requestId);
      if (command.action === "interrupt") storage.forgetOperation(ref, "stop");
      this.persist();
      this.accept(response);
    } catch (error) {
      if (this.reference !== ref || lifecycle !== this.lifecycle) return;
      if (this.transient(error)) {
        this.backoff(error);
        this.schedule();
      } else {
        ref.pending = ref.pending.filter((item) => item.requestId !== command.requestId);
        storage.forgetOperation(ref, command.requestId);
        if (command.action === "interrupt") {
          ref.stopRequested = false;
          storage.forgetOperation(ref, "stop");
        }
        this.persist();
        if (error instanceof ApiResponseError && error.status === 409) {
          await this.synchronize();
          return;
        }
        throw error;
      }
    } finally {
      this.sending.delete(command.requestId);
    }
  }
  private async resendPending(): Promise<void> {
    for (const command of [...(this.reference?.pending ?? [])]) await this.send(command);
  }
  private async request(
    action: GameCommandAction,
    fields: Partial<GameCommand> = {},
  ): Promise<void> {
    const ref = this.reference,
      status = this._status;
    if (!ref || !status) return;
    if (ref.pending.length >= 8) throw new Error(gameTexts().capacity);
    const command: GameCommand = {
      requestId: generateSessionId(),
      serverInstanceId: ref.serverInstanceId,
      controllerId: ref.controllerId,
      controllerEpoch: status.controllerEpoch,
      recoveryId: status.controllerRecoveryId,
      gameId: status.gameId,
      interactionId: status.interactionId,
      action,
      ...fields,
    };
    ref.pending.push(command);
    try {
      this.persist();
    } catch (error) {
      ref.pending = ref.pending.filter((item) => item !== command);
      throw error;
    }
    await this.send(command);
  }
  async move(move: Move): Promise<void> {
    if (this.canMove) await this.request("move", { move: move.usi });
  }
  async resign(): Promise<void> {
    if (this.canMove) await this.request("resign");
  }
  async declareWin(): Promise<void> {
    if (this.canMove) await this.request("declare");
  }
  async takeback(): Promise<void> {
    if (this.canTakeback) await this.request("takeback");
  }
  stop(): void {
    if (!this.reference) return;
    const previous = this.reference.stopRequested;
    this.reference.stopRequested = true;
    try {
      storage.writeJournal(this.reference);
    } catch (error) {
      this.reference.stopRequested = previous;
      this.handlers.error(error);
      return;
    }
    if (this._status)
      void this.request("interrupt")
        .then(() => {
          if (!this.socketReady) this.schedule();
        })
        .catch((error) => this.handlers.error(error));
    else this.schedule();
  }
  dispose(): void {
    const token = this.reference?.requestId ?? this.bindingToken;
    if (token) this.release(token, false);
    else {
      ++this.lifecycle;
      this.detach();
    }
  }
  annotate(type: SearchInfoSenderType, info: SearchInfo & { usi: string }): void {
    const slots = {
      [SearchInfoSenderType.RESEARCHER]: "researchInfo",
      [SearchInfoSenderType.RESEARCHER_2]: "researchInfo2",
      [SearchInfoSenderType.RESEARCHER_3]: "researchInfo3",
      [SearchInfoSenderType.RESEARCHER_4]: "researchInfo4",
    } as const;
    if (
      !this.active ||
      !this.socketReady ||
      !this._status ||
      !this.reference ||
      this.socket?.readyState !== 1 ||
      info.usi !== this.recordManager.record.usi ||
      !(type in slots)
    )
      return;
    const slot = slots[type as keyof typeof slots];
    if (
      Date.now() - (this.annotationTimes.get(slot) ?? -Infinity) < 1000 ||
      this.reference.pending.length
    )
      return;
    this.annotationTimes.set(slot, Date.now());
    const command: GameCommand = {
      requestId: generateSessionId(),
      serverInstanceId: this.reference.serverInstanceId,
      controllerId: this.reference.controllerId,
      controllerEpoch: this._status.controllerEpoch,
      gameId: this._status.gameId,
      interactionId: this._status.interactionId,
      action: "annotate",
      nodeId: this._status.record.currentId,
      annotation: { slot, info: encodeSearchInfo(info) },
    };
    this.socket.send(JSON.stringify({ type: "annotation", value: command }));
  }
}
