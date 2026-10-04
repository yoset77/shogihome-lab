import { ImmutablePosition, Move } from "tsshogi";
import { USIInfoCommand } from "@/common/game/usi";

type onStartSearchHandler = (sessionID: number, position: ImmutablePosition) => void;

type onUpdateUSIInfoHandler = (
  sessionID: number,
  position: ImmutablePosition,
  name: string,
  info: USIInfoCommand,
  ponderMove?: Move,
) => void;

let onStartSearch: onStartSearchHandler = () => {};
let onUpdateUSIInfo: onUpdateUSIInfoHandler = () => {};
const infoSessions = new Set<number>();

export function setInfoSessionActive(sessionID: number, active: boolean): void {
  if (active) infoSessions.add(sessionID);
  else infoSessions.delete(sessionID);
}

export function isInfoSessionActive(sessionID: number): boolean {
  return infoSessions.has(sessionID);
}

export function setOnStartSearchHandler(handler: onStartSearchHandler) {
  onStartSearch = handler;
}

export function triggerOnStartSearch(sessionID: number, position: ImmutablePosition) {
  onStartSearch(sessionID, position);
}

export function setOnUpdateUSIInfoHandler(handler: onUpdateUSIInfoHandler) {
  onUpdateUSIInfo = handler;
}

export function dispatchUSIInfoUpdate(
  sessionID: number,
  position: ImmutablePosition,
  name: string,
  info: USIInfoCommand,
  ponderMove?: Move,
) {
  onUpdateUSIInfo(sessionID, position, name, info, ponderMove);
}
