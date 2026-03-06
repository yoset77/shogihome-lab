type MessageHandler = (data: string) => void;
type MessageListener = (data: string) => boolean; // Return true to remove listener

export interface LanEngineInfo {
  id: string;
  name: string;
  type?: "game" | "research" | "both";
  path: string;
}

export type LanEngineStatus = "disconnected" | "connecting" | "connected";

export class LanEngine {
  private ws: WebSocket | null = null;
  private onMessageHandler: MessageHandler | null = null;
  private messageListeners: MessageListener[] = [];
  private engineListCache: LanEngineInfo[] | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: number | null = null;
  private isExplicitlyClosed = true;
  private _status: LanEngineStatus = "disconnected";
  private statusListeners: ((status: LanEngineStatus) => void)[] = [];
  private commandQueue: string[] = [];
  private pingIntervalId: number | null = null;
  private pongTimeoutId: number | null = null;

  constructor(private sessionId: string) {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      window.addEventListener("beforeunload", this.onBeforeUnload);
    }
  }

  private onVisibilityChange = () => {
    if (document.visibilityState === "visible" && !this.isExplicitlyClosed) {
      console.log(`Foreground detected. Refreshing session ${this.sessionId}...`);
      this.clearReconnect();
      if (this.ws) {
        // Close the potentially zombie connection without triggering normal onclose logic.
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
    this.isExplicitlyClosed = false;
    return new Promise((resolve) => {
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

      this.ws.onopen = () => {
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
        } catch (e) {
          // ignore
        }

        this.messageListeners = this.messageListeners.filter((listener) => !listener(data));
        if (this.onMessageHandler) {
          this.onMessageHandler(data);
        }
      };

      this.ws.onclose = (event) => {
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
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      window.removeEventListener("beforeunload", this.onBeforeUnload);
    }
    this.clearReconnect();
    this.stopHeartbeat();
    this.commandQueue = [];
    if (this.ws) {
      this.ws.close();
    }
    this.setStatus("disconnected");
  }

  sendCommand(command: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(command);
      } catch (e) {
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

  async getEngineList(force = false): Promise<LanEngineInfo[]> {
    if (this.engineListCache && !force) {
      return this.engineListCache;
    }

    if (!this.isConnected()) {
      // Auto connect if not connected, using a dummy handler for now
      await this.connect(() => {});
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for engine list"));
      }, 5000);

      this.messageListeners.push((data: string) => {
        try {
          const json = JSON.parse(data);
          if (json.engineList) {
            clearTimeout(timeout);
            this.engineListCache = json.engineList;
            resolve(json.engineList);
            return true; // Remove listener
          }
        } catch (e) {
          // ignore
        }
        return false; // Keep listener
      });

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
