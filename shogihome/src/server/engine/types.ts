import type { WebSocket } from "ws";

export type EngineConfig = {
  id: string;
  name: string;
  type?: string | string[];
  skipAnalysisDB?: boolean;
  analysisDBGroupId?: string;
  analysisDBGroupName?: string;
};

export enum EngineState {
  UNINITIALIZED,
  STARTING,
  WAITING_USIOK,
  WAITING_READYOK,
  READY,
  THINKING,
  STOPPING_SEARCH,
  TERMINATING,
  STOPPED,
}

export type EngineHandle = {
  write: (command: string) => void;
  close: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off: (event: string, listener: (...args: unknown[]) => void) => void;
  removeAllListeners: (event?: string) => void;
};

export interface ExtendedWebSocket extends WebSocket {
  isAlive?: boolean;
}
