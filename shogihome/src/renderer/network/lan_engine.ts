import {
  decodeServerRelayMessage,
  encodeClientRelayMessage,
  isValidUsiCommand,
  type ClientRelayMessage,
  type LanEngineInfo,
  type ServerRelayMessage,
} from "@/common/engine/relay_protocol";

type MessageHandler = (data: ServerRelayMessage) => void;
type MessageListener = (data: ServerRelayMessage) => boolean; // Return true to remove listener

export type LanEngineStatus = "disconnected" | "connecting" | "connected";

const ENGINE_LIST_CACHE_TTL_MS = 30_000;
const TERMINATE_CONNECT_TIMEOUT_MS = 3_000;

const timeout = (timeoutMs: number, message: string): Promise<never> =>
  new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

const decodeRetiredSocketEngineOutput = (data: unknown): ServerRelayMessage | null => {
  const result = decodeServerRelayMessage(data);
  if (!result.ok) return null;
  const message = result.value;
  return message.type === "engineOutput" &&
    typeof message.positionCommand === "string" &&
    /^(?:bestmove|checkmate|info)(?:\s|$)/.test(message.output)
    ? message
    : null;
};

export class LanEngine {
  private ws: WebSocket | null = null;
  private onMessageHandler: MessageHandler | null = null;
  private messageListeners: MessageListener[] = [];
  private engineListCache: LanEngineInfo[] | null = null;
  private engineListCacheTimestamp: number | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: number | null = null;
  private isExplicitlyClosed = true;
  private _status: LanEngineStatus = "disconnected";
  private statusListeners: ((status: LanEngineStatus) => void)[] = [];
  private commandQueue: string[] = [];
  private pingIntervalId: number | null = null;
  private pongTimeoutId: number | null = null;
  private pendingEngineListPromise: Promise<LanEngineInfo[]> | null = null;
  private listenersRegistered = false;
  private activeRequestCount = 0;

  constructor(private sessionId: string) {}

  private ensureListenersRegistered() {
    if (this.listenersRegistered || typeof document === "undefined") return;
    this.listenersRegistered = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("beforeunload", this.onBeforeUnload);
  }

  private removeListeners() {
    if (!this.listenersRegistered || typeof document === "undefined") return;
    this.listenersRegistered = false;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("beforeunload", this.onBeforeUnload);
  }

  private onVisibilityChange = () => {
    if (document.visibilityState === "visible" && !this.isExplicitlyClosed) {
      console.log(`Foreground detected. Refreshing session ${this.sessionId}...`);
      this.clearReconnect();
      if (this.ws) {
        if (this.ws.readyState === WebSocket.CONNECTING) {
          return;
        }
        const oldWs = this.ws;
        const preserveEngineOutput = oldWs.readyState === WebSocket.OPEN;
        // Keep onmessage intact so in-flight engine output is still dispatched;
        // server replay starts only after the server detects the disconnect.
        this.stopHeartbeat();
        oldWs.onopen = null;
        oldWs.onerror = null;
        oldWs.onclose = null;
        if (!preserveEngineOutput) {
          oldWs.onmessage = null;
        }
        this.ws = null;
        oldWs.close();
      }
      this.connect().catch((e) => {
        console.warn(`Reconnect after visibility change failed: ${e}`);
      });
    }
  };

  private onBeforeUnload = () => {
    this.disconnect();
  };

  get status(): LanEngineStatus {
    return this._status;
  }

  private setStatus(status: LanEngineStatus) {
    if (this._status !== status) {
      this._status = status;
      this.statusListeners.forEach((listener) => listener(status));
    }
  }

  subscribeStatus(listener: (status: LanEngineStatus) => void): () => void {
    this.statusListeners.push(listener);
    listener(this._status);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== listener);
    };
  }

  connect(onMessage?: MessageHandler): Promise<void> {
    this.ensureListenersRegistered();
    this.isExplicitlyClosed = false;
    return new Promise((resolve, reject) => {
      if (
        this.ws &&
        (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      ) {
        console.log("WebSocket is already connected or connecting.");
        if (onMessage) {
          this.onMessageHandler = onMessage;
        }
        if (this.ws.readyState === WebSocket.OPEN) {
          this.setStatus("connected");
          this.flushCommandQueue();
          this.startHeartbeat(this.ws);
        } else {
          this.setStatus("connecting");
        }
        resolve();
        return;
      }

      this.clearReconnect();
      this.setStatus("connecting");

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/?sessionId=${this.sessionId}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      if (onMessage) {
        this.onMessageHandler = onMessage;
      }

      let connected = false;
      const timeoutId = window.setTimeout(() => {
        if (!connected) {
          if (this.ws === ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
            this.setStatus("disconnected");
            if (!this.isExplicitlyClosed) {
              this.scheduleReconnect();
            }
          }
          reject(new Error("WebSocket connection timeout"));
        }
      }, 10000);

      ws.onopen = () => {
        connected = true;
        window.clearTimeout(timeoutId);
        console.log("WebSocket connection established");
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        this.flushCommandQueue();
        this.startHeartbeat(ws);
        resolve();
      };

      ws.onmessage = (event) => {
        const data = event.data;

        if (this.ws !== ws) {
          const message = decodeRetiredSocketEngineOutput(data);
          if (message && this.onMessageHandler) {
            this.onMessageHandler(message);
          }
          return;
        }

        const result = decodeServerRelayMessage(data);
        if (!result.ok) {
          console.warn(`Invalid WebSocket relay frame ignored: ${result.error}`);
          return;
        }
        const message = result.value;
        if (message.type === "notice" && message.notice === "pong") {
          this.handlePong(ws);
          return;
        }

        this.messageListeners = this.messageListeners.filter((listener) => !listener(message));
        if (this.onMessageHandler) {
          this.onMessageHandler(message);
        }
      };

      ws.onclose = (event) => {
        if (!connected) {
          window.clearTimeout(timeoutId);
          if (this.ws === ws) {
            this.ws = null;
            this.setStatus("disconnected");
            if (!this.isExplicitlyClosed) {
              this.scheduleReconnect();
            }
          }
          reject(
            new Error(`WebSocket connection closed: code=${event.code} reason=${event.reason}`),
          );
          return;
        }
        console.log(`WebSocket connection closed: code=${event.code} reason=${event.reason}`);
        if (this.ws === ws) {
          this.ws = null;
          this.stopHeartbeat();
          this.setStatus("disconnected");
          if (!this.isExplicitlyClosed) {
            this.scheduleReconnect();
          }
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        if (!connected) {
          window.clearTimeout(timeoutId);
          if (this.ws === ws) {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
            ws.close();
            this.ws = null;
            this.setStatus("disconnected");
            if (!this.isExplicitlyClosed) {
              this.scheduleReconnect();
            }
          }
          reject(new Error("WebSocket connection error"));
        }
      };
    });
  }

  private startHeartbeat(ws: WebSocket) {
    this.stopHeartbeat();
    // Send ping every 6 seconds
    this.pingIntervalId = window.setInterval(() => {
      this.sendPing(ws);
    }, 6000);
  }
  private stopHeartbeat() {
    if (this.pingIntervalId !== null) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    if (this.pongTimeoutId !== null) {
      clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
    }
  }

  private sendPing(ws: WebSocket) {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;

    // Set timeout for pong response (e.g. 6 seconds)
    if (this.pongTimeoutId === null) {
      this.pongTimeoutId = window.setTimeout(() => {
        console.warn("Heartbeat timeout. Closing connection.");
        if (this.ws === ws) {
          ws.close(); // This will trigger onclose and scheduleReconnect
        }
      }, 6000);
    }
    try {
      ws.send(encodeClientRelayMessage({ type: "ping" }));
    } catch (e) {
      console.warn("Failed to send ping:", e);
    }
  }

  private handlePong(ws: WebSocket) {
    if (this.ws !== ws) return;
    if (this.pongTimeoutId !== null) {
      clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout !== null) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      this.reconnectAttempts++;
      this.connect().catch(() => {
        // Reconnection failed, will be rescheduled by onclose
      });
    }, delay);
  }

  private clearReconnect() {
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  disconnect() {
    this.isExplicitlyClosed = true;
    this.removeListeners();
    this.clearReconnect();
    this.stopHeartbeat();
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.flushCommandQueue();
      }
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
    this.commandQueue = [];
    this.messageListeners = [];
    this.setStatus("disconnected");
  }

  private waitForSocketOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (ws.readyState !== WebSocket.CONNECTING) {
      return Promise.reject(new Error("WebSocket is not connecting"));
    }

    return new Promise((resolve, reject) => {
      const previousOnOpen = ws.onopen;
      const previousOnError = ws.onerror;
      const previousOnClose = ws.onclose;
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("WebSocket termination connection timeout"));
      }, timeoutMs);

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        if (ws.onopen === handleOpen) ws.onopen = previousOnOpen;
        if (ws.onerror === handleError) ws.onerror = previousOnError;
        if (ws.onclose === handleClose) ws.onclose = previousOnClose;
      };

      const handleOpen = (event: Event) => {
        previousOnOpen?.call(ws, event);
        cleanup();
        resolve();
      };

      const handleError = (event: Event) => {
        previousOnError?.call(ws, event);
        cleanup();
        reject(new Error("WebSocket termination connection error"));
      };

      const handleClose = (event: CloseEvent) => {
        previousOnClose?.call(ws, event);
        cleanup();
        reject(new Error("WebSocket termination connection closed"));
      };

      ws.onopen = handleOpen;
      ws.onerror = handleError;
      ws.onclose = handleClose;
    });
  }

  async terminateEngine(): Promise<void> {
    this.clearReconnect();
    try {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        await this.waitForSocketOpen(this.ws, TERMINATE_CONNECT_TIMEOUT_MS);
      } else if (!this.isConnected()) {
        const connectPromise = this.connect();
        connectPromise.catch(() => {
          // terminateEngine uses a shorter timeout below.
        });
        if (this.ws) {
          await this.waitForSocketOpen(this.ws, TERMINATE_CONNECT_TIMEOUT_MS);
        } else {
          await Promise.race([
            connectPromise,
            timeout(TERMINATE_CONNECT_TIMEOUT_MS, "WebSocket termination fallback timeout"),
          ]);
        }
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(encodeClientRelayMessage({ type: "stopEngine" }));
      }
    } catch (e) {
      console.warn("Failed to send stop_engine before disconnect:", e);
    } finally {
      this.disconnect();
    }
  }

  private sendRelayMessage(message: ClientRelayMessage) {
    let command: string;
    try {
      command = encodeClientRelayMessage(message);
    } catch (e) {
      console.warn("Invalid relay message blocked:", e);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(command);
      } catch {
        console.warn("Failed to send command, buffering:", command);
        this.commandQueue.push(command);
      }
    } else {
      console.log("WebSocket is not connected, buffering command:", command);
      this.commandQueue.push(command);
    }
  }

  sendUsiCommand(command: string) {
    if (!isValidUsiCommand(command)) {
      console.warn("Invalid USI command blocked:", command);
      return;
    }
    this.sendRelayMessage({ type: "usi", command: command.trim() });
  }

  private flushCommandQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.commandQueue.length > 0) {
      console.log(`Flushing ${this.commandQueue.length} buffered commands`);
      while (this.commandQueue.length > 0) {
        const command = this.commandQueue.shift();
        if (command) {
          try {
            this.ws.send(command);
          } catch (e) {
            console.error("Failed to flush command:", command, e);
            // If send fails here, connection is likely broken again.
            // Push back to front? Or just let onclose handle it?
            // The command was validated before buffering, so preserve it for a retry.
            this.commandQueue.unshift(command);
            break;
          }
        }
      }
    }
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  addMessageListener(listener: MessageListener) {
    this.messageListeners.push(listener);
  }

  removeMessageListener(listener: MessageListener) {
    this.messageListeners = this.messageListeners.filter((l) => l !== listener);
  }

  get isIdle(): boolean {
    return this.activeRequestCount === 0;
  }

  async getEngineList(force = false): Promise<LanEngineInfo[]> {
    this.activeRequestCount++;
    try {
      if (!force && this.engineListCache && this.engineListCacheTimestamp !== null) {
        const age = Date.now() - this.engineListCacheTimestamp;
        if (age < ENGINE_LIST_CACHE_TTL_MS) {
          return this.engineListCache;
        }
      }

      if (this.pendingEngineListPromise) {
        return this.pendingEngineListPromise;
      }

      const promise = this.fetchEngineList();
      this.pendingEngineListPromise = promise;
      try {
        return await promise;
      } finally {
        this.pendingEngineListPromise = null;
      }
    } finally {
      this.activeRequestCount--;
    }
  }

  private async fetchEngineList(): Promise<LanEngineInfo[]> {
    if (!this.isConnected()) {
      try {
        await this.connect();
      } catch (e) {
        throw new Error(
          `Failed to connect while fetching engine list: ${e instanceof Error ? e.message : String(e)}`,
          {
            cause: e,
          },
        );
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeMessageListener(listener);
        reject(new Error("Timeout waiting for engine list"));
      }, 5000);

      const listener = (message: ServerRelayMessage) => {
        if (message.type === "engineList") {
          clearTimeout(timeout);
          this.engineListCache = message.engines;
          this.engineListCacheTimestamp = Date.now();
          resolve(message.engines);
          return true;
        }
        return false;
      };

      this.addMessageListener(listener);
      this.sendRelayMessage({ type: "getEngineList" });
    });
  }

  startEngine(engineId: string) {
    this.sendRelayMessage({ type: "startEngine", engineId });
  }

  stopEngine() {
    this.sendRelayMessage({ type: "stopEngine" });
  }

  setMultiPV(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) {
      console.warn("Invalid MultiPV value blocked:", value);
      return;
    }
    this.sendUsiCommand(`setoption name MultiPV value ${value}`);
  }
}

import { generateSessionId } from "@/renderer/helpers/unique";

const getDiscoveryId = () => {
  return generateSessionId();
};

export const lanDiscoveryEngine = new LanEngine("discovery-" + getDiscoveryId());
