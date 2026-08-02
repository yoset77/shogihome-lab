import net from "net";
import readline from "readline";
import { WebSocket } from "ws";
import { getNormalizedSfenAndHash } from "@/server/usi/sfen";
import { saveAnalysisResults } from "@/server/database/sqlite";
import { parseInfoCommand, type USIInfoCommand } from "@/common/game/usi";
import {
  decodeClientRelayMessage,
  encodeClientRelayMessage,
  encodeSessionRelayMessage,
  isValidUsiCommand,
  type ClientRelayMessage,
  type RelayState,
  type SessionRelayPayload,
} from "@/common/engine/relay_protocol";
import {
  ANALYSIS_DB_MIN_DEPTH,
  CONNECTION_PROTECTION_TIMEOUT,
  ENGINE_STOP_TIMEOUT_MS,
  REMOTE_ENGINE_HOST,
  REMOTE_ENGINE_PORT,
} from "@/server/config";
import { authenticateSocket } from "@/server/engine/auth";
import { engineConfigCache, getEngineList } from "@/server/engine/list";
import {
  EngineState,
  type EngineConfig,
  type EngineHandle,
  type ExtendedWebSocket,
} from "@/server/engine/types";

const findLast = (
  commands: string[],
  predicate: (command: string) => boolean,
): { command: string; index: number } | undefined => {
  for (let index = commands.length - 1; index >= 0; index--) {
    const command = commands[index];
    if (predicate(command)) {
      return { command, index };
    }
  }
  return undefined;
};

export class EngineSession {
  private currentEngineId: string | null = null;
  private currentEngineConfig: EngineConfig | null = null;
  private engineHandle: EngineHandle | null = null;
  private connectingSocket: net.Socket | null = null;
  private engineState = EngineState.UNINITIALIZED;
  private commandQueue: string[] = [];
  private postStopCommandQueue: string[] = [];
  private stopTimeout: NodeJS.Timeout | null = null;
  private currentEngineSfen: string | null = null;
  private pendingGoSfen: string | null = null;
  private isExplicitlyTerminated = false;
  private ws: ExtendedWebSocket | null = null;
  private cleanupTimeout: NodeJS.Timeout | null = null;
  private messageBuffer: { data: SessionRelayPayload; createdAt: number }[] = [];
  private lastInfos = new Map<number, USIInfoCommand>();

  private readonly MAX_QUEUE_SIZE = 100;
  private readonly MAX_BUFFERED_MESSAGES = 50;

  constructor(
    public readonly sessionId: string,
    private readonly removeSession: (sessionId: string) => void = () => {},
  ) {}

  private pushToQueue(queue: string[], command: string) {
    if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
      return;
    }
    queue.push(command);
    if (queue.length > this.MAX_QUEUE_SIZE) {
      queue.shift();
    }
  }

  attach(ws: ExtendedWebSocket) {
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
    this.isExplicitlyTerminated = false;
    if (this.engineState === EngineState.STOPPING_SEARCH) {
      this.startStopTimeout();
    }

    ws.on("message", (message, isBinary) => {
      if (this.ws !== ws) {
        console.log(`Ignoring message for session ${this.sessionId} (socket replaced)`);
        return;
      }
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

    // Replay buffered messages
    console.log(
      `Replaying ${this.messageBuffer.length} buffered messages for session ${this.sessionId}`,
    );
    while (this.messageBuffer.length > 0) {
      const { data, createdAt } = this.messageBuffer.shift()!;
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
    this.clearStopTimeout();

    if (
      this.isExplicitlyTerminated ||
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
    this.stopTimeout = setTimeout(() => {
      this.stopTimeout = null;
      if (this.engineState !== EngineState.STOPPING_SEARCH || !this.ws) {
        return;
      }
      console.error(
        `Engine for session ${this.sessionId} did not respond to stop command within ${ENGINE_STOP_TIMEOUT_MS}ms. Resetting engine session.`,
      );
      this.sendError("Engine did not respond to stop command. Session reset.");
      if (this.engineHandle) {
        this.engineState = EngineState.TERMINATING;
        this.engineHandle.close();
      }
    }, ENGINE_STOP_TIMEOUT_MS);
  }

  private terminate() {
    this.clearCleanupTimeout();
    this.clearStopTimeout();
    this.messageBuffer = [];
    this.lastInfos.clear();
    if (this.connectingSocket) {
      this.connectingSocket.destroy();
      this.connectingSocket = null;
    }
    if (this.engineHandle && this.engineState !== EngineState.TERMINATING) {
      this.engineState = EngineState.TERMINATING;
      this.engineHandle.close();
    } else {
      this.onEngineClose();
    }
    this.removeSession(this.sessionId);
  }

  private sendToClient(data: SessionRelayPayload, createdAt: number = Date.now()) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const delay = Math.max(0, Date.now() - createdAt);
      this.ws.send(encodeSessionRelayMessage(data, delay));
    } else {
      // Buffer messages during disconnection
      // For 'info' messages, we only keep the latest few to avoid memory issues
      if (data.type === "engineOutput" && data.output.startsWith("info")) {
        // Keep only the last 10 info messages if disconnected
        const infoCount = this.messageBuffer.filter(
          (message) =>
            message.data.type === "engineOutput" && message.data.output.startsWith("info"),
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
          (message) =>
            message.data.type === "engineOutput" && message.data.output.startsWith("info"),
        );
        this.messageBuffer.splice(removableInfoIndex >= 0 ? removableInfoIndex : 0, 1);
      }
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

  private sendToEngine(command: string) {
    if (this.engineHandle) {
      if (!isValidUsiCommand(command)) {
        console.warn(`Invalid USI command blocked: ${command}`);
        return;
      }

      if (command.startsWith("position ")) {
        this.currentEngineSfen = command;
      }
      if (command.startsWith("go")) {
        this.engineState = EngineState.THINKING;
        this.pendingGoSfen = this.currentEngineSfen;
        this.sendState();
      }
      console.log(`Sending to engine (${this.sessionId}): ${command}`);
      this.engineHandle.write(command + "\n");
    }
  }

  private collectPostStopCommands(): string[] {
    const startIndex = this.postStopCommandQueue.lastIndexOf("usinewgame");
    const commands = this.postStopCommandQueue.slice(startIndex >= 0 ? startIndex : 0);
    const result: string[] = [];

    const latestMultiPV = findLast(commands, (cmd) => cmd.startsWith("setoption name MultiPV"));
    const latestGameover = findLast(commands, (cmd) => cmd.startsWith("gameover"));
    const latestPosition = findLast(commands, (cmd) => cmd.startsWith("position"));
    const latestGo = findLast(commands, (cmd) => cmd.startsWith("go"));

    if (startIndex >= 0) {
      result.push("usinewgame");
    }
    if (latestMultiPV) {
      result.push(latestMultiPV.command);
    }
    if (latestGameover) {
      result.push(latestGameover.command);
    }
    if (latestPosition) {
      result.push(latestPosition.command);
    }
    if (latestGo && (!latestPosition || latestGo.index > latestPosition.index)) {
      result.push(latestGo.command);
    }

    const knownCommands = new Set(result);
    const knownKinds = new Set([
      "setoption name MultiPV",
      "gameover",
      "position",
      "go",
      "usinewgame",
    ]);
    for (const command of commands) {
      const known =
        knownKinds.has(command) || [...knownKinds].some((kind) => command.startsWith(kind));
      if (!known && !knownCommands.has(command)) {
        result.push(command);
        knownCommands.add(command);
      }
    }
    return result;
  }

  private onEngineClose() {
    if (
      this.engineState === EngineState.STOPPED ||
      this.engineState === EngineState.UNINITIALIZED ||
      this.sessionId.startsWith("discovery-")
    ) {
      return;
    }
    console.log(`Engine process exited for session ${this.sessionId}.`);
    if (this.engineHandle) {
      this.engineHandle.removeAllListeners();
      this.engineHandle = null;
    }
    this.currentEngineId = null;
    this.currentEngineConfig = null;
    this.engineState = EngineState.STOPPED;
    this.commandQueue.length = 0;
    this.postStopCommandQueue.length = 0;
    this.clearStopTimeout();
    this.currentEngineSfen = null;
    this.pendingGoSfen = null;
    this.lastInfos.clear();
    this.sendState();
    this.sendToClient({ type: "notice", notice: "engineStopped" });
  }

  private setupEngineHandlers(stream: NodeJS.ReadableStream, rl?: readline.Interface) {
    const interface_ = rl || readline.createInterface({ input: stream });
    interface_.on("line", (line) => {
      if (!line.startsWith("info")) {
        console.log(`Engine output (${this.sessionId}): ${line}`);
      }

      if (line.startsWith("info ")) {
        const parsed = parseInfoCommand(line.substring(5));
        const hasScore = parsed.scoreCP !== undefined || parsed.scoreMate !== undefined;
        const hasInvalidBound =
          (parsed.lowerbound && parsed.upperbound) ||
          ((parsed.lowerbound || parsed.upperbound) && !hasScore);
        if (parsed.depth !== undefined && !hasInvalidBound) {
          const pvId = parsed.multipv || 1;
          const currentInfo = this.lastInfos.get(pvId) || {};
          // Merge with previous to keep nodes/time if omitted in this line
          const nextInfo = { ...currentInfo, ...parsed };
          if (hasScore) {
            // Score kind and bound describe one atomic USI score update.
            nextInfo.scoreCP = parsed.scoreCP;
            nextInfo.scoreMate = parsed.scoreMate;
            nextInfo.lowerbound = parsed.lowerbound;
            nextInfo.upperbound = parsed.upperbound;
          }
          this.lastInfos.set(pvId, nextInfo);
        }
      }

      if (line.trim().startsWith("WRAPPER_ERROR:")) {
        console.error(`Engine wrapper error: ${line}`);
        this.sendError(line);
        this.terminate();
        return;
      }

      if (this.engineState === EngineState.TERMINATING) {
        return;
      }

      this.sendToClient({
        type: "engineOutput",
        positionCommand: this.pendingGoSfen,
        output: line,
      });

      if (line.startsWith("bestmove") || line.startsWith("checkmate")) {
        if (
          line.startsWith("bestmove") &&
          this.currentEngineConfig &&
          !this.currentEngineConfig.skipAnalysisDB &&
          this.pendingGoSfen &&
          this.lastInfos.size > 0
        ) {
          const validInfos = new Map<number, USIInfoCommand>();
          const savedMoves = new Set<string>();
          const sortedInfos = [...this.lastInfos.entries()].sort(([a], [b]) => a - b);
          for (const [multipv, info] of sortedInfos) {
            if (info.depth === undefined || info.depth < ANALYSIS_DB_MIN_DEPTH) continue;

            const firstMove = info.pv?.[0];
            if (firstMove && savedMoves.has(firstMove)) continue;
            if (firstMove) savedMoves.add(firstMove);
            validInfos.set(multipv, info);
          }

          if (validInfos.size > 0) {
            const parsedSfen = getNormalizedSfenAndHash(this.pendingGoSfen);
            if (parsedSfen) {
              const engineKey =
                this.currentEngineConfig.analysisDBGroupId || this.currentEngineConfig.id;
              const engineName =
                this.currentEngineConfig.analysisDBGroupName || this.currentEngineConfig.name;
              saveAnalysisResults(
                parsedSfen.hash,
                parsedSfen.sfen,
                engineKey,
                engineName,
                validInfos,
              );
            }
          }
        }
        this.lastInfos.clear();

        if (this.engineState === EngineState.STOPPING_SEARCH) {
          this.clearStopTimeout();

          const commandsToRun = this.collectPostStopCommands();
          this.postStopCommandQueue.length = 0;
          this.engineState = EngineState.READY;
          this.sendState();

          if (commandsToRun.length > 0) {
            for (const command of commandsToRun) {
              this.sendToEngine(command);
            }
          }
        } else {
          this.engineState = EngineState.READY;
          this.sendState();
        }
      }

      if (this.engineState === EngineState.WAITING_USIOK && line.trim() === "usiok") {
        this.engineState = EngineState.WAITING_READYOK;
        this.sendToEngine("isready");
      } else if (this.engineState === EngineState.WAITING_READYOK && line.trim() === "readyok") {
        this.engineState = EngineState.READY;
        this.sendState();
        this.sendToClient({ type: "notice", notice: "engineReady" });
        while (this.commandQueue.length > 0) {
          const command = this.commandQueue.shift();
          if (command) this.sendToEngine(command);
        }
      }
    });
  }

  private startEngine(engineId: string) {
    if (this.engineHandle || this.engineState === EngineState.STARTING) {
      this.sendError("engine already running or starting");
      return;
    }
    this.engineState = EngineState.STARTING;
    this.currentEngineId = engineId;
    this.currentEngineConfig = engineConfigCache.get(engineId) || { id: engineId, name: engineId };

    console.log(`Connecting to remote engine at ${REMOTE_ENGINE_HOST}:${REMOTE_ENGINE_PORT}`);
    const socket = new net.Socket();
    this.connectingSocket = socket;

    const connectionTimeout = setTimeout(() => {
      console.error("Connection timed out after 5 seconds");
      this.sendError("connection timed out");
      socket.destroy();
      this.connectingSocket = null;
      this.onEngineClose();
    }, 5000);

    socket.on("connect", async () => {
      clearTimeout(connectionTimeout);
      if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
        socket.destroy();
        return;
      }
      console.log(`Connected to remote engine. Specifying engine ID: ${engineId}`);

      const accessToken = process.env.WRAPPER_ACCESS_TOKEN;

      const setup = (rl?: readline.Interface) => {
        if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
          socket.destroy();
          return;
        }

        this.connectingSocket = null;
        socket.write(`run ${engineId}\n`);

        this.engineState = EngineState.WAITING_USIOK;
        this.engineHandle = {
          write: (cmd) => socket.write(cmd),
          close: () => socket.end(),
          on: (e, l) => socket.on(e, l),
          off: (e, l) => socket.off(e, l),
          removeAllListeners: (e) => socket.removeAllListeners(e),
        };
        this.setupEngineHandlers(socket, rl);
        this.engineHandle.on("close", () => this.onEngineClose());
        this.engineHandle.on("error", (err) => {
          console.error("Remote engine connection error:", err);
          this.sendError("remote engine connection failed");
          this.onEngineClose();
        });
        this.sendToEngine("usi");
      };

      if (accessToken) {
        try {
          const rl = await authenticateSocket(socket, accessToken);
          setup(rl);
        } catch (err: unknown) {
          if (this.isExplicitlyTerminated) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Authentication failed: ${message}`);
          this.sendError(message);
          socket.destroy();
          this.onEngineClose();
        }
      } else {
        setup();
      }
    });

    socket.on("close", () => {
      clearTimeout(connectionTimeout);
      if (this.connectingSocket === socket) this.connectingSocket = null;
    });

    socket.on("error", (err) => {
      clearTimeout(connectionTimeout);
      if (this.connectingSocket === socket) this.connectingSocket = null;
      if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
        return;
      }
      if (this.engineState === EngineState.STARTING) {
        console.error("Failed to connect to remote engine:", err);
        this.sendError(`failed to connect to remote engine (${err.message})`);
        this.onEngineClose();
      }
    });

    socket.connect(REMOTE_ENGINE_PORT, REMOTE_ENGINE_HOST);
  }

  private handleMessage(message: ClientRelayMessage) {
    if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
      return;
    }
    console.log(`Received command (${this.sessionId}): ${encodeClientRelayMessage(message)}`);

    let command: string;
    switch (message.type) {
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
          (this.engineHandle || this.engineState === EngineState.STARTING)
        ) {
          console.log(
            `Engine ${engineId} is already active or starting for session ${this.sessionId}. Ignoring redundant start request.`,
          );
          this.sendState();
          return;
        }
        if (this.engineHandle || this.engineState === EngineState.STARTING) {
          this.sendError("engine already running or starting");
          return;
        }
        this.startEngine(engineId);
        return;
      }
      case "stopEngine": {
        const hasActiveEngineSession =
          this.connectingSocket ||
          this.engineHandle ||
          (this.engineState !== EngineState.UNINITIALIZED &&
            this.engineState !== EngineState.STOPPED);
        this.isExplicitlyTerminated = true;
        if (!hasActiveEngineSession) {
          return;
        }
        this.engineState = EngineState.TERMINATING;
        this.currentEngineId = null;
        this.commandQueue.length = 0;
        this.postStopCommandQueue.length = 0;
        this.clearStopTimeout();
        this.currentEngineSfen = null;
        this.pendingGoSfen = null;
        this.lastInfos.clear();
        if (this.connectingSocket) {
          this.connectingSocket.destroy();
          this.connectingSocket = null;
          this.onEngineClose();
          return;
        }
        if (this.engineHandle) {
          this.engineHandle.close();
        } else {
          this.onEngineClose();
        }
        return;
      }
      case "usi":
        command = message.command;
        break;
    }

    const handleStop = () => {
      if (this.engineState === EngineState.STOPPING_SEARCH) return;
      if (this.engineState === EngineState.THINKING) {
        this.engineState = EngineState.STOPPING_SEARCH;
        this.postStopCommandQueue.length = 0;
        this.sendToEngine("stop");
        this.startStopTimeout();
      }
    };

    if (command === "stop") {
      handleStop();
      return;
    }

    if (command === "quit") {
      this.isExplicitlyTerminated = true;
      this.sendToEngine(command);
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
      handleStop();
    }

    if (this.engineState === EngineState.STOPPING_SEARCH) {
      if (command !== "stop") this.pushToQueue(this.postStopCommandQueue, command);
      return;
    }

    if (command === "usi" || command === "isready") return;

    if (command.startsWith("setoption ")) {
      if (this.engineState === EngineState.READY) {
        this.sendToEngine(command);
      } else if (
        this.engineState === EngineState.STARTING ||
        this.engineState === EngineState.WAITING_USIOK ||
        this.engineState === EngineState.WAITING_READYOK
      ) {
        this.pushToQueue(this.commandQueue, command);
      } else {
        this.sendError(`engine not ready. Cannot process command: ${command}`);
      }
      return;
    }

    if (command === "usinewgame" || command.startsWith("gameover")) {
      if (this.engineState === EngineState.READY) {
        this.sendToEngine(command);
      } else if (
        this.engineState === EngineState.STARTING ||
        this.engineState === EngineState.WAITING_USIOK ||
        this.engineState === EngineState.WAITING_READYOK
      ) {
        this.pushToQueue(this.commandQueue, command);
      } else {
        this.sendError(`engine not ready. Cannot process command: ${command}`);
      }
      return;
    }

    if (this.engineState === EngineState.READY || this.engineState === EngineState.THINKING) {
      this.sendToEngine(command);
    } else if (
      this.engineState === EngineState.STARTING ||
      this.engineState === EngineState.WAITING_USIOK ||
      this.engineState === EngineState.WAITING_READYOK
    ) {
      this.pushToQueue(this.commandQueue, command);
    } else {
      this.sendError(`engine not started. Cannot process command: ${command}`);
    }
  }
}
