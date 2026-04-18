type MessageHandler = (data: string) => void;
type MessageListener = (data: string) => boolean; // Return true to remove listener

export interface LanEngineInfo {
  id: string;
  name: string;
  type?: ("game" | "research" | "mate")[];
}

export type LanEngineStatus = "disconnected" | "connecting" | "connected";

const ENGINE_LIST_CACHE_TTL_MS = 30_000;

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
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
        this.setStatus("disconnected");
      }
      this.connect();
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
          this.startHeartbeat();
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
      this.ws = new WebSocket(url);
      if (onMessage) {
        this.onMessageHandler = onMessage;
      }

      let connected = false;
      const timeoutId = window.setTimeout(() => {
        if (!connected) {
          if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
          }
          this.setStatus("disconnected");
          reject(new Error("WebSocket connection timeout"));
        }
      }, 10000);

      this.ws.onopen = () => {
        connected = true;
        window.clearTimeout(timeoutId);
        console.log("WebSocket connection established");
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        this.flushCommandQueue();
        this.startHeartbeat();
        resolve();
      };

      this.ws.onmessage = (event) => {
        const data = event.data;

        // Handle heartbeat
        try {
          const json = JSON.parse(data);
          if (json.info === "pong") {
            this.handlePong();
            return; // Don't propagate pong
          }
        } catch {
          // ignore
        }

        this.messageListeners = this.messageListeners.filter((listener) => !listener(data));
        if (this.onMessageHandler) {
          this.onMessageHandler(data);
        }
      };

      this.ws.onclose = (event) => {
        if (!connected) {
          window.clearTimeout(timeoutId);
          this.ws = null;
          this.setStatus("disconnected");
          reject(
            new Error(`WebSocket connection closed: code=${event.code} reason=${event.reason}`),
          );
          return;
        }
        console.log(`WebSocket connection closed: code=${event.code} reason=${event.reason}`);
        this.ws = null;
        this.stopHeartbeat();
        this.setStatus("disconnected");
        if (!this.isExplicitlyClosed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        if (!connected) {
          // Rejection will be handled by onclose which usually follows onerror,
          // but we can reject here to be safe and specific.
          window.clearTimeout(timeoutId);
          reject(new Error("WebSocket connection error"));
        }
      };
    });
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    // Send ping every 6 seconds
    this.pingIntervalId = window.setInterval(() => {
      this.sendPing();
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

  private sendPing() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Set timeout for pong response (e.g. 6 seconds)
    if (this.pongTimeoutId === null) {
      this.pongTimeoutId = window.setTimeout(() => {
        console.warn("Heartbeat timeout. Closing connection.");
        if (this.ws) {
          this.ws.close(); // This will trigger onclose and scheduleReconnect
        }
      }, 6000);
    }
    try {
      this.ws.send("ping");
    } catch (e) {
      console.warn("Failed to send ping:", e);
    }
  }

  private handlePong() {
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.flushCommandQueue();
      this.ws.close();
    }
    this.ws = null;
    this.commandQueue = [];
    this.messageListeners = [];
    this.setStatus("disconnected");
  }

  sendCommand(command: string) {
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
            // If we push back, we risk infinite loops if command is bad.
            // But if it's network, we should keep it.
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
        await this.connect(() => {});
      } catch (e) {
        throw new Error(
          `Failed to connect while fetching engine list: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeMessageListener(listener);
        reject(new Error("Timeout waiting for engine list"));
      }, 5000);

      const listener = (data: string) => {
        try {
          const json = JSON.parse(data);
          if (json.engineList) {
            clearTimeout(timeout);
            this.engineListCache = json.engineList;
            this.engineListCacheTimestamp = Date.now();
            resolve(json.engineList);
            return true;
          }
        } catch {
          // ignore
        }
        return false;
      };

      this.addMessageListener(listener);
      this.sendCommand("get_engine_list");
    });
  }

  startEngine(engineId: string) {
    this.sendCommand(`start_engine ${engineId}`);
  }

  stopEngine() {
    this.sendCommand("stop_engine");
  }

  setOption(name: string, value?: string | number) {
    if (value !== undefined) {
      this.sendCommand(`setoption name ${name} value ${value}`);
    } else {
      this.sendCommand(`setoption name ${name}`);
    }
  }
}

import { generateSessionId } from "@/renderer/helpers/unique";

const getDiscoveryId = () => {
  return generateSessionId();
};

export const lanDiscoveryEngine = new LanEngine("discovery-" + getDiscoveryId());
