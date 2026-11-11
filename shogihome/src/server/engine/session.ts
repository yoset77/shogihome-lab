import net from "net";
import { randomUUID } from "node:crypto";
import readline from "readline";
import { WebSocket } from "ws";
import { getNormalizedSfenAndHash } from "@/server/usi/sfen";
import { saveAnalysisResults } from "@/server/database/sqlite";
import { isUSITerminalOutput, parseInfoCommand, type USIInfoCommand } from "@/common/game/usi";
import { parseAnalysisInfo } from "@/common/analysis/types";
import {
  decodeClientRelayMessage,
  encodeClientRelayMessage,
  encodeSessionRelayMessage,
  isValidUsiCommand,
  type ClientRelayMessage,
  type RelayState,
  type SessionRelayPayload,
  type SearchRequest,
  type SearchSnapshot,
} from "@/common/engine/relay_protocol";
import {
  ANALYSIS_DB_MIN_DEPTH,
  CONNECTION_PROTECTION_TIMEOUT,
  ENGINE_STOP_TIMEOUT_MS,
  RELAY_READY_TIMEOUT_MS,
  REMOTE_ENGINE_HOST,
  REMOTE_ENGINE_PORT,
} from "@/server/config";
import { authenticateSocket } from "@/server/engine/auth";
import { fetchEngineConfigs, getEngineList } from "@/server/engine/list";
import { createRelayMessageLimiter, sendRelayFrame } from "@/server/engine/transport";
import { t } from "@/common/i18n";
import {
  EngineState,
  type EngineConfig,
  type EngineHandle,
  type ExtendedWebSocket,
} from "@/server/engine/types";
import { mergeAnalysisInfo, selectAnalysisInfosForSave } from "./analysis_info";
import { collectPostStopCommands } from "./command_queue";
import { engineRequirements, resourceRegistry, type ResourceLease } from "./resources";

type EngineRun = {
  socket: net.Socket | null;
  handle: EngineHandle | null;
  connectionTimeout?: NodeJS.Timeout;
  terminationTimeout?: NodeJS.Timeout;
  disposeTransport?: () => void;
  disposeOutput?: () => void;
  // Internal sessions leave reservation ownership with their caller.
  resourceLease?: ResourceLease;
};

export class EngineSession {
  private currentEngineId: string | null = null;
  private currentEngineConfig: EngineConfig | null = null;
  private engineRun: EngineRun = { socket: null, handle: null };
  private engineState = EngineState.UNINITIALIZED;
  // The startup readyok can be used by the first game only.
  private readyForNewGame = false;
  private commandQueue: string[] = [];
  private postStopCommandQueue: string[] = [];
  private stopTimeout: NodeJS.Timeout | null = null;
  private readyTimeout: NodeJS.Timeout | null = null;
  private currentEngineSfen: string | null = null;
  private pendingGoSfen: string | null = null;
  private terminationRequested = false;
  private ws: ExtendedWebSocket | null = null;
  private cleanupTimeout: NodeJS.Timeout | null = null;
  private messageBuffer: { data: SessionRelayPayload; createdAt: number }[] = [];
  private lastInfos = new Map<number, USIInfoCommand>();
  private instanceId = randomUUID();
  private searchRevision = 0;
  private acceptedSearch: SearchRequest | null = null;
  private activeSearch: SearchRequest | null = null;
  private queuedSearch: { request: SearchRequest; stopRequested: boolean } | null = null;
  private cancelledThrough = 0;
  private settledThrough = 0;
  private terminalSearch: {
    result: NonNullable<SearchSnapshot["terminal"]>;
    createdAt: number;
  } | null = null;
  private internalListeners = new Set<(event: SessionRelayPayload) => void>();

  get internalSnapshot() {
    return {
      state: this.engineState,
      instanceId: this.instanceId,
      active: this.activeSearch?.searchId ?? null,
      settled: this.settledThrough,
      cancelled: this.cancelledThrough,
      terminal: this.terminalSearch?.result ?? null,
    };
  }

  subscribeInternal(listener: (event: SessionRelayPayload) => void): () => void {
    if (this.owner !== "internal") throw new Error("Session is owned by relay");
    this.internalListeners.add(listener);
    return () => this.internalListeners.delete(listener);
  }

  dispatchInternal(message: ClientRelayMessage): void {
    if (this.owner !== "internal") throw new Error("Session is owned by relay");
    const decoded = decodeClientRelayMessage(encodeClientRelayMessage(message));
    if (!decoded.ok) throw new Error(decoded.error);
    this.handleMessage(decoded.value);
  }

  startInternalEngine(config: EngineConfig): void {
    if (this.owner !== "internal") throw new Error("Session is owned by relay");
    const decoded = decodeClientRelayMessage(
      encodeClientRelayMessage({ type: "startEngine", engineId: config.id }),
    );
    if (!decoded.ok) throw new Error(decoded.error);
    const run = this.engineRun;
    void this.startEngine(config.id, structuredClone(config)).catch((error) =>
      this.handleEngineTaskError(run, error),
    );
  }

  destroyInternal(): void {
    if (this.owner !== "internal") throw new Error("Session is owned by relay");
    this.destroyEngineTransport();
  }

  private sendSearchSnapshot() {
    // Snapshots are authoritative and regenerated on attach, never buffered as events.
    if (this.owner === "relay" && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) return;
    this.sendToClient({
      type: "searchSnapshot",
      instanceId: this.instanceId,
      revision: ++this.searchRevision,
      engineId: this.currentEngineId,
      accepted: this.acceptedSearch?.searchId ?? 0,
      cancelled: this.cancelledThrough,
      settled: this.settledThrough,
      active: this.activeSearch?.searchId ?? null,
      protectionMs: CONNECTION_PROTECTION_TIMEOUT,
      terminal: this.terminalSearch && {
        ...this.terminalSearch.result,
        delay: Math.max(0, Date.now() - this.terminalSearch.createdAt),
      },
    });
  }

  private startQueuedSearch() {
    if (this.engineState !== EngineState.READY || !this.queuedSearch) return;
    const { request: search, stopRequested } = this.queuedSearch;
    this.queuedSearch = null;
    if (search.searchId <= this.cancelledThrough) return;
    this.activeSearch = search;
    this.lastInfos.clear();
    this.setEnginePosition(search.position);
    this.beginSearch(search.go);
    if (stopRequested) this.requestSearchStop();
    this.sendSearchSnapshot();
  }

  private requestSearchStop() {
    if (this.engineState !== EngineState.THINKING) return;
    this.engineState = EngineState.STOPPING_SEARCH;
    this.postStopCommandQueue.length = 0;
    this.writeToEngine("stop");
    this.startStopTimeout();
  }

  private handleSearch(search: SearchRequest) {
    if (search.instanceId !== this.instanceId) {
      this.sendSearchSnapshot();
      return;
    }
    if (search.searchId <= this.cancelledThrough) {
      this.sendSearchSnapshot();
      return;
    }
    if (this.acceptedSearch && search.searchId <= this.acceptedSearch.searchId) {
      if (
        search.searchId === this.acceptedSearch.searchId &&
        (search.position !== this.acceptedSearch.position || search.go !== this.acceptedSearch.go)
      ) {
        this.sendError("Search ID reused with different parameters.");
      }
      this.sendSearchSnapshot();
      return;
    }
    if (!this.engineRun.handle || this.engineState === EngineState.STOPPED) {
      this.sendError("Engine not ready for search.");
      return;
    }
    this.acceptedSearch = search;
    this.queuedSearch = { request: search, stopRequested: false };
    this.terminalSearch = null;
    this.requestSearchStop();
    this.startQueuedSearch();
    this.sendSearchSnapshot();
  }

  private cancelSearch(instanceId: string, through: number) {
    if (instanceId !== this.instanceId) {
      this.sendSearchSnapshot();
      return;
    }
    this.cancelledThrough = Math.max(this.cancelledThrough, through);
    if (this.queuedSearch && this.queuedSearch.request.searchId <= this.cancelledThrough) {
      this.queuedSearch = null;
    }
    if (this.activeSearch && this.activeSearch.searchId <= this.cancelledThrough) {
      this.requestSearchStop();
    } else {
      this.settledThrough = this.cancelledThrough;
    }
    this.sendSearchSnapshot();
  }

  private readonly MAX_QUEUE_SIZE = 100;
  private readonly MAX_BUFFERED_MESSAGES = 50;

  constructor(
    public readonly sessionId: string,
    private readonly removeSession: (sessionId: string) => void = () => {},
    private readonly owner: "relay" | "internal" = "relay",
  ) {}

  private pushToQueue(queue: string[], command: string) {
    if (this.terminationRequested || this.engineState === EngineState.TERMINATING) {
      return;
    }
    queue.push(command);
    if (queue.length > this.MAX_QUEUE_SIZE) {
      queue.shift();
    }
  }

  attach(ws: ExtendedWebSocket) {
    if (this.owner !== "relay") throw new Error("Session is owned by server");
    if (this.terminationRequested) {
      ws.close(1000, "Session terminated");
      return;
    }
    console.log(`Attaching session ${this.sessionId} to new WebSocket`);
    this.clearCleanupTimeout();

    if (this.ws) {
      try {
        console.log(`Terminating replaced socket for session ${this.sessionId}`);
        this.ws.terminate();
      } catch {
        // ignore
      }
    }

    this.ws = ws;
    if (this.engineState === EngineState.STOPPING_SEARCH && !this.activeSearch) {
      this.startStopTimeout();
    }

    const acceptMessage = createRelayMessageLimiter(ws);
    ws.on("message", (message, isBinary) => {
      if (this.ws !== ws) {
        console.log(`Ignoring message for session ${this.sessionId} (socket replaced)`);
        return;
      }
      if (!acceptMessage(message)) return;
      if (isBinary) {
        console.warn(`Binary relay command blocked for session ${this.sessionId}`);
        return;
      }
      const result = decodeClientRelayMessage(message.toString());
      if (!result.ok) {
        console.warn(
          `Invalid relay command blocked for session ${this.sessionId}: ${result.error}`,
        );
        return;
      }
      this.handleMessage(result.value);
    });
    ws.on("close", () => this.handleDisconnect(ws));

    // Send initial state to client
    this.sendState();
    this.sendSearchSnapshot();

    // Replay buffered messages
    console.log(
      `Replaying ${this.messageBuffer.length} buffered messages for session ${this.sessionId}`,
    );
    // Failed sends may re-buffer; never replay the newly buffered tail in this loop.
    for (const { data, createdAt } of this.messageBuffer.splice(0)) {
      this.sendToClient(data, createdAt);
    }
  }

  private sendState() {
    let stateStr: RelayState = "uninitialized";
    switch (this.engineState) {
      case EngineState.STARTING:
      case EngineState.WAITING_USIOK:
      case EngineState.WAITING_READYOK:
        stateStr = "starting";
        break;
      case EngineState.THINKING:
      case EngineState.STOPPING_SEARCH:
        stateStr = "thinking";
        break;
      case EngineState.READY:
        stateStr = "ready";
        break;
      case EngineState.STOPPING_ENGINE:
      case EngineState.TERMINATING:
      case EngineState.STOPPED:
        stateStr = "stopped";
        break;
    }
    if (stateStr === "uninitialized" || stateStr === "stopped") {
      this.sendToClient({ type: "state", state: stateStr, engineId: null });
      return;
    }
    if (!this.currentEngineId) {
      console.error(`Active engine state without an engine ID for session ${this.sessionId}`);
      this.sendToClient({ type: "state", state: "uninitialized", engineId: null });
      return;
    }
    this.sendToClient({ type: "state", state: stateStr, engineId: this.currentEngineId });
  }

  private handleDisconnect(socket: ExtendedWebSocket) {
    if (this.ws !== socket) {
      console.log(`Ignoring disconnect for session ${this.sessionId} (socket replaced)`);
      return;
    }

    console.log(`WebSocket disconnected for session ${this.sessionId}`);
    this.ws = null;
    if (!this.activeSearch && this.engineState !== EngineState.STOPPING_ENGINE)
      this.clearStopTimeout();

    if (
      this.terminationRequested ||
      this.sessionId.startsWith("discovery-") ||
      this.engineState === EngineState.UNINITIALIZED
    ) {
      this.terminate();
    } else {
      console.log(
        `Session ${this.sessionId} entered disconnection protection (${CONNECTION_PROTECTION_TIMEOUT}ms)`,
      );
      this.cleanupTimeout = setTimeout(() => {
        console.log(`Session ${this.sessionId} protection timed out. Terminating.`);
        this.terminate();
      }, CONNECTION_PROTECTION_TIMEOUT);
    }
  }

  private clearCleanupTimeout() {
    if (this.cleanupTimeout) {
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }
  }

  private clearStopTimeout() {
    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }
  }

  private startStopTimeout() {
    this.clearStopTimeout();
    const run = this.engineRun;
    this.stopTimeout = setTimeout(() => {
      if (this.engineRun !== run) return;
      this.stopTimeout = null;
      if (
        this.engineState !== EngineState.STOPPING_ENGINE &&
        (this.engineState !== EngineState.STOPPING_SEARCH || (!this.ws && !this.activeSearch))
      ) {
        return;
      }
      console.error(
        `Engine for session ${this.sessionId} did not respond to stop command within ${ENGINE_STOP_TIMEOUT_MS}ms. Resetting engine session.`,
      );
      this.sendError("Engine did not respond to stop command. Session reset.");
      this.closeEngineTransport();
    }, ENGINE_STOP_TIMEOUT_MS);
  }

  private clearReadyTimeout() {
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
  }

  private startReadyTimeout() {
    if (this.owner !== "relay" || this.readyTimeout) return;
    const run = this.engineRun;
    this.readyTimeout = setTimeout(() => {
      if (this.engineRun !== run) return;
      this.readyTimeout = null;
      if (this.engineState !== EngineState.WAITING_READYOK) return;
      console.error(
        `Engine for session ${this.sessionId} did not respond to isready within ${RELAY_READY_TIMEOUT_MS}ms. Resetting engine session.`,
      );
      this.sendError(t.remoteEngineReadyTimedOut);
      this.closeEngineTransport();
    }, RELAY_READY_TIMEOUT_MS);
  }

  private terminate(graceful = true) {
    const alreadyTerminated = this.terminationRequested;
    this.terminationRequested = true;
    this.clearCleanupTimeout();
    if (alreadyTerminated && graceful) return;

    this.messageBuffer = [];
    this.commandQueue.length = 0;
    this.postStopCommandQueue.length = 0;
    this.queuedSearch = null;
    // Unregister only once: a new session may already be using the same ID.
    if (!alreadyTerminated) this.removeSession(this.sessionId);

    if (
      graceful &&
      this.engineRun.handle &&
      (this.engineState === EngineState.THINKING ||
        this.engineState === EngineState.STOPPING_SEARCH)
    ) {
      const needsStop = this.engineState === EngineState.THINKING;
      this.engineState = EngineState.STOPPING_ENGINE;
      // Preserve an existing stop deadline, including across browser disconnects.
      if (!this.stopTimeout) this.startStopTimeout();
      if (needsStop) {
        try {
          this.writeToEngine("stop");
        } catch (error) {
          console.error(`Failed to send stop while terminating session ${this.sessionId}`, error);
          this.closeEngineTransport();
        }
      }
      return;
    }
    this.closeEngineTransport();
  }

  private closeEngineTransport() {
    if (this.engineState === EngineState.TERMINATING) return;
    this.clearStopTimeout();
    this.clearReadyTimeout();
    this.lastInfos.clear();
    this.currentEngineSfen = null;
    this.pendingGoSfen = null;
    const run = this.engineRun;
    if (run.handle) {
      this.engineState = EngineState.TERMINATING;
      // Keep the lease until close, but bound a peer that never finishes shutdown.
      run.terminationTimeout = setTimeout(
        () => this.destroyEngineTransport(run),
        ENGINE_STOP_TIMEOUT_MS,
      );
      try {
        run.handle.close();
      } catch (error) {
        console.error(`Engine transport close failed for session ${this.sessionId}`, error);
        this.destroyEngineTransport(run);
      }
    } else {
      this.destroyEngineTransport(run);
    }
  }

  private destroyEngineTransport(run = this.engineRun) {
    if (this.engineRun !== run) return;
    try {
      if (run.handle?.destroy) run.handle.destroy();
      else run.socket?.destroy();
    } catch (error) {
      console.error(`Engine transport destroy failed for session ${this.sessionId}`, error);
    } finally {
      // Release and state finalization must run even if the peer teardown fails.
      this.onEngineClose(run);
    }
  }

  private failEngineRun(run: EngineRun, message: string) {
    if (this.engineRun !== run) return;
    this.runCleanupStep("error notification", () => this.sendError(message));
    this.destroyEngineTransport(run);
  }

  private runCleanupStep(label: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      console.error(`Engine cleanup failed during ${label} (${this.sessionId})`, error);
    }
  }

  private handleEngineTaskError(run: EngineRun, error: unknown) {
    console.error(`Engine background task failed for session ${this.sessionId}`, error);
    try {
      this.failEngineRun(run, t.remoteEngineConnectionFailed);
    } catch (cleanupError) {
      // Never let a cleanup failure turn into an unhandled rejection.
      console.error(`Engine failure cleanup failed for session ${this.sessionId}`, cleanupError);
    }
  }

  private sendToClient(data: SessionRelayPayload, createdAt: number = Date.now()) {
    if (this.owner === "internal") {
      // Deliver only after the complete synchronous USI transition.
      queueMicrotask(() => {
        for (const listener of [...this.internalListeners]) {
          try {
            listener(data);
          } catch (error) {
            console.error(`Internal engine listener failed (${this.sessionId})`, error);
          }
        }
      });
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const delay = Math.max(0, Date.now() - createdAt);
      if (sendRelayFrame(this.ws, encodeSessionRelayMessage(data, delay))) return;
    }
    if (data.type === "searchSnapshot") return;
    // Buffer messages during disconnection, keeping only the latest info messages.
    if (data.type === "engineOutput" && data.output.startsWith("info")) {
      const infoCount = this.messageBuffer.filter(
        (message) => message.data.type === "engineOutput" && message.data.output.startsWith("info"),
      ).length;
      if (infoCount >= 10) {
        const firstInfoIndex = this.messageBuffer.findIndex(
          (message) =>
            message.data.type === "engineOutput" && message.data.output.startsWith("info"),
        );
        if (firstInfoIndex !== -1) {
          this.messageBuffer.splice(firstInfoIndex, 1);
        }
      }
    }
    this.messageBuffer.push({ data, createdAt });
    while (this.messageBuffer.length > this.MAX_BUFFERED_MESSAGES) {
      const removableInfoIndex = this.messageBuffer.findIndex(
        (message) => message.data.type === "engineOutput" && message.data.output.startsWith("info"),
      );
      this.messageBuffer.splice(removableInfoIndex >= 0 ? removableInfoIndex : 0, 1);
    }
  }

  private sendError(message: string) {
    const safeMessage = (() => {
      if (!message.includes("WRAPPER_ERROR:")) {
        return message.startsWith("error: ") ? message : `error: ${message}`;
      }
      console.error(`Internal Wrapper Error: ${message}`);
      if (message.includes("Engine executable not found")) {
        return "error: Engine executable not found.";
      }
      if (message.includes("Engine path for type")) {
        return "error: Engine path configuration error.";
      }
      return "error: Internal server error.";
    })();
    this.sendToClient({ type: "error", message: safeMessage });
  }

  private writeToEngine(command: string) {
    if (!this.engineRun.handle) return;
    if (!isValidUsiCommand(command)) {
      console.warn(`Invalid USI command blocked: ${command}`);
      return;
    }
    console.log(`Sending to engine (${this.sessionId}): ${command}`);
    this.engineRun.handle.write(command + "\n");
  }

  private beginReadyCheck(reason: "startup" | "newGame") {
    this.engineState = EngineState.WAITING_READYOK;
    if (reason === "newGame") {
      this.sendState();
      this.startReadyTimeout();
    }
    this.writeToEngine("isready");
  }

  private beginSearch(go: string) {
    this.readyForNewGame = false;
    this.engineState = EngineState.THINKING;
    this.pendingGoSfen = this.currentEngineSfen;
    this.sendState();
    this.writeToEngine(go);
  }

  private setEnginePosition(command: string) {
    this.currentEngineSfen = command;
    this.writeToEngine(command);
  }

  private executeUsiCommand(command: string) {
    // Readiness and stop gating happen before executing a decoded command.
    if (!this.engineRun.handle) return;
    if (command === "usinewgame" && !this.readyForNewGame) {
      this.pushToQueue(this.commandQueue, command);
      this.beginReadyCheck("newGame");
      return;
    }
    if (command.startsWith("go")) {
      this.beginSearch(command);
      return;
    }
    if (command === "usinewgame" || command.startsWith("gameover")) {
      this.readyForNewGame = false;
    }
    if (command.startsWith("position ")) {
      this.setEnginePosition(command);
      return;
    }
    this.writeToEngine(command);
  }

  private onEngineClose(run = this.engineRun) {
    if (this.engineRun !== run) return;
    // Retire before disposing callbacks, which may synchronously re-enter cleanup.
    this.engineRun = { socket: null, handle: null };
    this.clearConnectionTimeout(run);
    clearTimeout(run.terminationTimeout);
    this.runCleanupStep("output disposal", () => run.disposeOutput?.());
    this.runCleanupStep("transport disposal", () => run.disposeTransport?.());
    this.runCleanupStep("resource release", () => run.resourceLease?.release());
    run.resourceLease = undefined;
    this.readyForNewGame = false;
    this.clearReadyTimeout();
    if (
      this.engineState === EngineState.STOPPED ||
      this.engineState === EngineState.UNINITIALIZED
    ) {
      return;
    }
    console.log(`Engine process exited for session ${this.sessionId}.`);
    this.currentEngineId = null;
    this.currentEngineConfig = null;
    this.engineState = EngineState.STOPPED;
    this.commandQueue.length = 0;
    this.postStopCommandQueue.length = 0;
    this.clearStopTimeout();
    this.currentEngineSfen = null;
    this.pendingGoSfen = null;
    this.lastInfos.clear();
    this.instanceId = randomUUID();
    this.acceptedSearch = null;
    this.activeSearch = null;
    this.queuedSearch = null;
    this.terminalSearch = null;
    this.cancelledThrough = 0;
    this.settledThrough = 0;
    this.runCleanupStep("state notification", () => this.sendState());
    this.runCleanupStep("snapshot notification", () => this.sendSearchSnapshot());
    this.runCleanupStep("shutdown notification", () =>
      this.sendToClient({ type: "notice", notice: "engineStopped" }),
    );
  }

  private saveCurrentAnalysis() {
    if (
      !this.currentEngineConfig ||
      this.currentEngineConfig.skipAnalysisDB ||
      !this.pendingGoSfen ||
      this.lastInfos.size === 0
    ) {
      return;
    }
    const validInfos = selectAnalysisInfosForSave(this.lastInfos, ANALYSIS_DB_MIN_DEPTH);
    if (validInfos.size === 0) return;
    const parsedSfen = getNormalizedSfenAndHash(this.pendingGoSfen);
    if (!parsedSfen) return;
    const engineKey = this.currentEngineConfig.analysisDBGroupId || this.currentEngineConfig.id;
    const engineName =
      this.currentEngineConfig.analysisDBGroupName || this.currentEngineConfig.name;
    saveAnalysisResults(parsedSfen.hash, parsedSfen.sfen, engineKey, engineName, validInfos);
  }

  private setupEngineHandlers(
    stream: NodeJS.ReadableStream,
    rl?: readline.Interface,
    run = this.engineRun,
  ) {
    const interface_ = rl || readline.createInterface({ input: stream });
    // Socket handlers own transport errors; consume readline's forwarded errors.
    interface_.on("error", () => {});
    const onLine = (line: string) => {
      if (this.engineRun !== run) return;
      try {
        this.handleEngineLine(line);
      } catch (error) {
        console.error(`Engine output handler failed (${this.sessionId})`, error);
        this.sendError(t.remoteEngineInvalidOutput);
        this.terminate(false);
      }
    };
    interface_.on("line", onLine);
    run.disposeOutput = () => {
      interface_.off("line", onLine);
      interface_.close();
    };
  }

  private handleEngineLine(line: string) {
    const terminal = /^(bestmove|checkmate)/.test(line.trimStart());
    if (terminal) line = line.trim().replace(/[ \t]+/g, " ");
    if (!line.startsWith("info")) {
      console.log(`Engine output (${this.sessionId}): ${line}`);
    }

    if (this.engineState === EngineState.TERMINATING || this.engineState === EngineState.STOPPED) {
      return;
    }

    if (terminal && !isUSITerminalOutput(line)) throw new Error("Invalid USI terminal output");
    if (
      terminal &&
      [EngineState.STARTING, EngineState.WAITING_USIOK, EngineState.WAITING_READYOK].includes(
        this.engineState,
      )
    ) {
      return;
    }

    if (line.startsWith("info ")) {
      const parsed =
        this.owner === "internal" ? parseAnalysisInfo(line) : parseInfoCommand(line.substring(5));
      if (!parsed) return;
      this.recordAnalysisInfo(parsed);
    }

    if (line.trim().startsWith("WRAPPER_ERROR:")) {
      console.error(`Engine wrapper error: ${line}`);
      this.sendError(line);
      this.terminate(false);
      return;
    }

    const stoppingEngine = this.engineState === EngineState.STOPPING_ENGINE;
    if (!stoppingEngine) {
      this.sendToClient({
        type: "engineOutput",
        positionCommand: this.pendingGoSfen,
        output: line,
        ...(this.activeSearch
          ? { instanceId: this.instanceId, searchId: this.activeSearch.searchId }
          : {}),
      });
    }

    if (terminal) {
      this.handleTerminalOutput(line, stoppingEngine);
      return;
    }

    if (this.engineState === EngineState.WAITING_USIOK && line.trim() === "usiok") {
      this.beginReadyCheck("startup");
    } else if (this.engineState === EngineState.WAITING_READYOK && line.trim() === "readyok") {
      this.handleReadyOk();
    }
  }

  private recordAnalysisInfo(info: USIInfoCommand) {
    const pvId = info.multipv || 1;
    const nextInfo = mergeAnalysisInfo(this.lastInfos.get(pvId), info);
    if (nextInfo) this.lastInfos.set(pvId, nextInfo);
  }

  private handleTerminalOutput(line: string, stoppingEngine: boolean) {
    if (line.startsWith("bestmove")) {
      try {
        this.saveCurrentAnalysis();
      } catch (error) {
        console.error(`Failed to persist analysis (${this.sessionId})`, error);
      }
    }
    this.lastInfos.clear();
    if (stoppingEngine) {
      this.closeEngineTransport();
      return;
    }
    if (this.activeSearch) {
      this.terminalSearch = {
        createdAt: Date.now(),
        result: {
          searchId: this.activeSearch.searchId,
          position: this.activeSearch.position,
          output: line,
          delay: 0,
        },
      };
      this.activeSearch = null;
      this.settledThrough = this.cancelledThrough;
    }
    if (this.engineState === EngineState.STOPPING_SEARCH) {
      this.clearStopTimeout();

      const commandsToRun = collectPostStopCommands(this.postStopCommandQueue);
      this.postStopCommandQueue.length = 0;
      this.engineState = EngineState.READY;

      for (const command of commandsToRun) {
        this.handleRawUsiCommand(command);
      }
    } else {
      this.engineState = EngineState.READY;
    }
    this.sendState();
    this.startQueuedSearch();
    this.sendSearchSnapshot();
  }

  private handleReadyOk() {
    this.clearReadyTimeout();
    this.engineState = EngineState.READY;
    this.readyForNewGame = true;
    // Replaying may start another readiness check; do not drain a live queue.
    for (const command of this.commandQueue.splice(0)) this.handleRawUsiCommand(command);
    this.sendState();
    if (this.engineState === EngineState.READY || this.engineState === EngineState.THINKING)
      this.sendToClient({ type: "notice", notice: "engineReady" });
    this.startQueuedSearch();
    this.sendSearchSnapshot();
  }

  private async startEngine(engineId: string, config?: EngineConfig): Promise<void> {
    if (this.terminationRequested) return;
    if (this.engineRun.handle || this.engineState === EngineState.STARTING) {
      this.sendError("engine already running or starting");
      return;
    }
    this.engineState = EngineState.STARTING;
    this.readyForNewGame = false;
    this.currentEngineId = engineId;
    const run = this.engineRun;
    try {
      // Relay starts resolve their own catalog, independently of browser discovery.
      const resolvedConfig =
        config ?? (await fetchEngineConfigs()).find((entry) => entry.id === engineId);
      if (!this.isStartingEngine(run)) return;
      if (!resolvedConfig) throw new Error(t.remoteEngineUnavailable);
      if (this.owner === "relay") {
        run.resourceLease = resourceRegistry.acquire(...engineRequirements(resolvedConfig));
      }
      this.currentEngineConfig = structuredClone(resolvedConfig);
    } catch (error) {
      if (!this.isStartingEngine(run)) return;
      console.warn(`Engine start rejected for session ${this.sessionId}:`, error);
      this.sendError(error instanceof Error ? error.message : String(error));
      this.onEngineClose(run);
      return;
    }

    this.connectEngine(run, engineId);
  }

  private isStartingEngine(run: EngineRun): boolean {
    return (
      this.engineRun === run &&
      !this.terminationRequested &&
      this.engineState === EngineState.STARTING
    );
  }

  private clearConnectionTimeout(run: EngineRun) {
    clearTimeout(run.connectionTimeout);
    run.connectionTimeout = undefined;
  }

  private connectEngine(run: EngineRun, engineId: string) {
    console.log(`Connecting to remote engine at ${REMOTE_ENGINE_HOST}:${REMOTE_ENGINE_PORT}`);
    const socket = new net.Socket();
    run.socket = socket;
    run.connectionTimeout = setTimeout(() => {
      if (!this.isStartingEngine(run)) return;
      console.error("Connection timed out after 5 seconds");
      this.failEngineRun(run, "connection timed out");
    }, 5000);

    const onConnect = () => {
      if (!this.isStartingEngine(run)) return;
      this.clearConnectionTimeout(run);
      void this.openEngineTransport(run, socket, engineId).catch((error) =>
        this.handleEngineTaskError(run, error),
      );
    };
    const onClose = () => {
      if (this.isStartingEngine(run)) this.sendError(t.remoteEngineConnectionFailed);
      this.onEngineClose(run);
    };
    const onError = (error: Error) => {
      if (this.engineRun !== run) return;
      console.error(
        run.handle ? "Remote engine connection error:" : "Failed to connect to remote engine:",
        error,
      );
      this.failEngineRun(run, t.remoteEngineConnectionFailed);
    };
    socket.on("connect", onConnect);
    socket.on("close", onClose);
    socket.on("error", onError);
    run.disposeTransport = () => {
      socket.off("connect", onConnect);
      socket.off("close", onClose);
      socket.off("error", onError);
      // A destroyed socket can still emit an already scheduled error.
      socket.on("error", () => {});
    };
    try {
      socket.connect(REMOTE_ENGINE_PORT, REMOTE_ENGINE_HOST);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async openEngineTransport(run: EngineRun, socket: net.Socket, engineId: string) {
    console.log(`Connected to remote engine. Specifying engine ID: ${engineId}`);
    const accessToken = process.env.WRAPPER_ACCESS_TOKEN;
    let rl: readline.Interface | undefined;
    if (accessToken) {
      try {
        rl = await authenticateSocket(socket, accessToken);
      } catch (error) {
        if (!this.isStartingEngine(run)) return;
        console.error("Authentication failed:", error);
        this.failEngineRun(run, t.remoteEngineConnectionFailed);
        return;
      }
    }
    if (!this.isStartingEngine(run)) {
      rl?.close();
      return;
    }
    try {
      socket.write(`run ${engineId}\n`);
      this.engineState = EngineState.WAITING_USIOK;
      run.handle = {
        write: (cmd) => socket.write(cmd),
        close: () => socket.end(),
        destroy: () => socket.destroy(),
      };
      this.setupEngineHandlers(socket, rl, run);
      this.writeToEngine("usi");
    } catch (error) {
      if (this.engineRun !== run) return;
      if (!run.disposeOutput) rl?.close();
      console.error("Engine connection setup failed:", error);
      this.failEngineRun(run, t.remoteEngineConnectionFailed);
    }
  }

  private handleMessage(message: ClientRelayMessage) {
    if (this.terminationRequested || this.engineState === EngineState.TERMINATING) {
      return;
    }
    console.log(`Received command (${this.sessionId}): ${encodeClientRelayMessage(message)}`);

    switch (message.type) {
      case "search":
        this.handleSearch(message);
        return;
      case "cancelSearch":
        this.cancelSearch(message.instanceId, message.through);
        return;
      case "stopSearch":
        if (message.instanceId === this.instanceId) {
          if (message.searchId === this.queuedSearch?.request.searchId)
            this.queuedSearch.stopRequested = true;
          else if (message.searchId === this.activeSearch?.searchId) this.requestSearchStop();
        }
        this.sendSearchSnapshot();
        return;
      case "getEngineList":
        if (this.ws) {
          getEngineList(this.ws);
        }
        return;
      case "ping":
        this.sendToClient({ type: "notice", notice: "pong" });
        return;
      case "startEngine": {
        const engineId = message.engineId;
        if (
          this.currentEngineId === engineId &&
          (this.engineRun.handle || this.engineState === EngineState.STARTING)
        ) {
          console.log(
            `Engine ${engineId} is already active or starting for session ${this.sessionId}. Ignoring redundant start request.`,
          );
          this.sendState();
          return;
        }
        if (this.engineRun.handle || this.engineState === EngineState.STARTING) {
          this.sendError("engine already running or starting");
          return;
        }
        const run = this.engineRun;
        void this.startEngine(engineId).catch((error) => this.handleEngineTaskError(run, error));
        return;
      }
      case "stopEngine":
        this.terminate();
        return;
      case "usi":
        this.handleRawUsiCommand(message.command);
        return;
    }
  }

  private handleRawUsiCommand(command: string) {
    if (command === "stop") {
      if (this.queuedSearch) this.queuedSearch.stopRequested = true;
      if (this.commandQueue.some((queued) => queued.startsWith("go")))
        this.pushToQueue(this.commandQueue, command);
      if (this.postStopCommandQueue.some((queued) => queued.startsWith("go")))
        this.pushToQueue(this.postStopCommandQueue, command);
      this.requestSearchStop();
      return;
    }

    if (command === "quit") {
      this.terminate();
      return;
    }

    if (
      this.engineState === EngineState.THINKING &&
      (command.startsWith("position") ||
        command.startsWith("go") ||
        command.startsWith("setoption") ||
        command.startsWith("gameover") ||
        command === "usinewgame")
    ) {
      console.warn(`Implicitly stopping engine for session ${this.sessionId}`);
      this.requestSearchStop();
    }

    if (this.engineState === EngineState.STOPPING_SEARCH) {
      this.pushToQueue(this.postStopCommandQueue, command);
      return;
    }

    if (command === "usi" || command === "isready") return;

    if (this.engineState === EngineState.READY || this.engineState === EngineState.THINKING) {
      this.executeUsiCommand(command);
    } else if (
      this.engineState === EngineState.STARTING ||
      this.engineState === EngineState.WAITING_USIOK ||
      this.engineState === EngineState.WAITING_READYOK
    ) {
      this.pushToQueue(this.commandQueue, command);
    } else {
      const reason =
        command.startsWith("setoption ") ||
        command === "usinewgame" ||
        command.startsWith("gameover")
          ? "not ready"
          : "not started";
      this.sendError(`engine ${reason}. Cannot process command: ${command}`);
    }
  }
}
