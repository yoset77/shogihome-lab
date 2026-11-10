import type { WebSocket } from "ws";
import type { EngineResourceConfig } from "@/common/engine/relay_protocol";

export type EngineConfig = {
  id: string;
  name: string;
  type?: string | string[];
  skipAnalysisDB?: boolean;
  analysisDBGroupId?: string;
  analysisDBGroupName?: string;
  threads?: number;
  resource?: EngineResourceConfig;
};

export enum EngineState {
  UNINITIALIZED,
  STARTING,
  WAITING_USIOK,
  WAITING_READYOK,
  READY,
  THINKING,
  STOPPING_SEARCH,
  STOPPING_ENGINE,
  TERMINATING,
  STOPPED,
}

export type EngineHandle = {
  write: (command: string) => void;
  close: () => void;
  destroy?: () => void;
};

export interface ExtendedWebSocket extends WebSocket {
  isAlive?: boolean;
}
