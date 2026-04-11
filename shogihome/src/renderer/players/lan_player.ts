import { Player, SearchHandler, SearchInfo } from "./player";
import { ImmutablePosition, Color } from "tsshogi";
import { TimeStates } from "@/common/game/time";
import { LanEngine } from "@/renderer/network/lan_engine";
import { GameResult } from "@/common/game/result";
import { parseUSIPV, USIInfoCommand, parseInfoCommand } from "@/common/game/usi";
import { dispatchUSIInfoUpdate, triggerOnStartSearch } from "./usi_events";
import { t } from "@/common/i18n";
import api from "@/renderer/ipc/api";
import { USIEngineExtraBookConfig } from "@/common/settings/usi";
import { searchBookMovesForPlayer } from "./book_search";

import { generateSessionId } from "@/renderer/helpers/unique";

const STOP_WAIT_TIMEOUT_MS = 15000;
const READY_REPLAY_TIMEOUT_MS = 5000;

function getSessionId(sessionKey: string): string {
  const localStorageKey = `shogihome-lab-session-id-${sessionKey}`;
  let id = localStorage.getItem(localStorageKey);
  if (!id) {
    id = generateSessionId();
    localStorage.setItem(localStorageKey, id);
  }
  return id;
}

const lanPlayers: { [sessionID: number]: LanPlayer } = {};

export function isActiveLanPlayerSession(sessionID: number): boolean {
  return !!lanPlayers[sessionID];
}

export class LanPlayer implements Player {
  private handler?: SearchHandler;
  private position?: ImmutablePosition;
  private onSearchInfo?: (info: SearchInfo) => void;
  private info?: SearchInfo;
  private usiInfoTimeout?: number;
  private _sessionID: number;
  private engineId: string;
  private engineName: string;
  private currentSfen: string = "";
  private isThinking: boolean = false;
  private stopPromiseResolver: (() => void) | null = null;
  private stopPromiseRejector: ((err: Error) => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopPromiseTimeoutId: number | null = null;
  private readyReplayTimeoutId: number | null = null;
  private _multiPV: number = 1;
  private onErrorCallback?: (e: Error) => void;
  private lanEngine: LanEngine;
  private bookSessionID?: string;
  private unsubscribeStatus?: () => void;

  constructor(
    sessionKey: string,
    engineId: string,
    engineName: string,
    onSearchInfo?: (info: SearchInfo) => void,
    onError?: (e: Error) => void,
    private extraBook?: USIEngineExtraBookConfig,
  ) {
    this.engineId = engineId;
    this.engineName = engineName;
    this.onSearchInfo = onSearchInfo;
    this.onErrorCallback = onError;

    // Use deterministic session ID for LAN engines to avoid collisions and pruning.
    // USIPlayer uses IDs from 1. We use a high offset.
    if (sessionKey === "research_main") {
      this._sessionID = 200000;
    } else if (sessionKey === "research_analysis") {
      this._sessionID = 200100;
    } else if (sessionKey.startsWith("research_sub_")) {
      const index = parseInt(sessionKey.substring("research_sub_".length));
      this._sessionID = 200000 + index;
    } else {
      const randomBuffer = new Uint32Array(1);
      window.crypto.getRandomValues(randomBuffer);
      this._sessionID = 300000 + (randomBuffer[0] % 100000);
    }

    this.lanEngine = new LanEngine(getSessionId(sessionKey));
    this.unsubscribeStatus = this.lanEngine.subscribeStatus((status) => {
      if (status === "disconnected") {
        this.handleTransportDisconnect();
      }
    });
  }

  get name(): string {
    return this.engineName;
  }

  get sessionID(): number {
    return this._sessionID;
  }

  isEngine(): boolean {
    return true;
  }

  async launch(): Promise<void> {
    try {
      if (this.extraBook?.enabled && this.extraBook.filePath) {
        this.bookSessionID = await api.openBookAsNewSession(this.extraBook.filePath, {});
      }

      await this.lanEngine.connect((message: string) => {
        this.onMessage(message);
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.lanEngine.removeMessageListener(readyListener);
          reject(new Error("Timeout: Failed to receive ready message from engine"));
        }, 10000);

        const readyListener = (message: string) => {
          try {
            const data = JSON.parse(message);
            if (
              data.info === "info: engine is ready" ||
              data.state === "ready" ||
              data.state === "thinking"
            ) {
              clearTimeout(timeout);
              this.lanEngine.removeMessageListener(readyListener);
              resolve();
            } else if (data.error) {
              clearTimeout(timeout);
              this.lanEngine.removeMessageListener(readyListener);
              reject(new Error(data.error));
            }
          } catch {
            // ignore
          }
          return false;
        };

        this.lanEngine.addMessageListener(readyListener);
        const engineId = this.engineId.startsWith("lan-engine:")
          ? this.engineId.substring("lan-engine:".length)
          : this.engineId;
        this.lanEngine.startEngine(engineId);
      });

      lanPlayers[this._sessionID] = this;
    } catch (e) {
      this.lanEngine.stopEngine();
      this.lanEngine.disconnect();
      this.unsubscribeStatus?.();
      this.unsubscribeStatus = undefined;
      if (this.bookSessionID) {
        api.closeBook(this.bookSessionID);
        this.bookSessionID = undefined;
      }
      delete lanPlayers[this._sessionID];
      throw e;
    }
  }

  async readyNewGame(): Promise<void> {
    if (this.isThinking) {
      await this.stopAndWait();
    }
    this.lanEngine.sendCommand("usinewgame");
  }

  async startSearch(
    position: ImmutablePosition,
    usi: string,
    timeStates: TimeStates,
    handler: SearchHandler,
  ): Promise<void> {
    const isNewSfen = this.currentSfen !== usi;
    this.handler = handler;
    this.position = position;
    this.currentSfen = usi;
    if (isNewSfen) {
      this.clearPendingInfo();
    }
    if (await this.searchBook()) {
      return;
    }
    if (this.isThinking) {
      await this.stopAndWait();
    }
    this.lanEngine.sendCommand(usi); // "position ..."

    // ShogiHome keeps the time after adding the increment.
    // However, USI requires the time before adding the increment (btime + binc).
    // So we subtract the increment from the current time.
    const black = timeStates.black;
    const white = timeStates.white;
    const byoyomi = timeStates[position.color === Color.BLACK ? "black" : "white"].byoyomi || 0;

    const btime = black.timeMs - (black.increment || 0) * 1e3;
    const wtime = white.timeMs - (white.increment || 0) * 1e3;
    const binc = byoyomi === 0 ? (black.increment || 0) * 1e3 : 0;
    const winc = byoyomi === 0 ? (white.increment || 0) * 1e3 : 0;

    let goCommand = `go btime ${btime} wtime ${wtime}`;
    if (byoyomi > 0) {
      goCommand += ` byoyomi ${byoyomi * 1e3}`;
    } else if (binc > 0 || winc > 0) {
      goCommand += ` binc ${binc} winc ${winc}`;
    }
    this.lanEngine.sendCommand(goCommand);
    this.isThinking = true;
    triggerOnStartSearch(this._sessionID, this.position);
  }

  async startResearch(position: ImmutablePosition, usi: string): Promise<void> {
    this.handler = undefined;
    this.position = position.clone();
    this.currentSfen = usi;
    this.clearPendingInfo();
    if (await this.searchBook()) {
      return;
    }
    if (this.isThinking) {
      await this.stopAndWait();
    }
    this.lanEngine.sendCommand(usi);
    this.lanEngine.sendCommand("go infinite");
    this.isThinking = true;
    triggerOnStartSearch(this._sessionID, this.position);
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  async startPonder(
    _position: ImmutablePosition,
    _usi: string,
    _timeStates: TimeStates,
  ): Promise<void> {
    // Ponder is not supported in this implementation.
  }

  async startMateSearch(
    _position: ImmutablePosition,
    _usi: string,
    _maxSeconds: number | undefined,
  ): Promise<void> {
    // Mate search is not supported in this implementation.
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  async stop(): Promise<void> {
    if (this.isThinking) {
      await this.stopAndWait();
    }
  }

  async gameover(result: GameResult): Promise<void> {
    if (this.isThinking) {
      await this.stopAndWait();
    }
    this.lanEngine.sendCommand("gameover " + result);
  }

  async close(): Promise<void> {
    this.clearPendingInfo();
    try {
      if (this.isThinking) {
        await this.stopAndWait();
      }
    } finally {
      this.lanEngine.stopEngine();
      this.lanEngine.disconnect();
      this.unsubscribeStatus?.();
      this.unsubscribeStatus = undefined;
      delete lanPlayers[this._sessionID];
      if (this.bookSessionID) {
        api.closeBook(this.bookSessionID);
      }
    }
  }

  get multiPV(): number | undefined {
    return this._multiPV;
  }

  async setMultiPV(multiPV: number): Promise<void> {
    this._multiPV = multiPV;
    if (this.lanEngine.isConnected()) {
      this.lanEngine.setOption("MultiPV", multiPV);
    }
  }

  private async searchBook(): Promise<boolean> {
    if (!this.bookSessionID || !this.position) {
      return false;
    }
    const extraBook = this.extraBook;
    if (!extraBook) {
      return false;
    }
    // Check maxMoves: skip book if current ply exceeds the limit
    const maxMoves = extraBook.maxMoves ?? 0;
    if (maxMoves > 0) {
      const movesIndex = this.currentSfen.indexOf(" moves ");
      const ply =
        movesIndex >= 0 ? this.currentSfen.substring(movesIndex + 7).split(" ").length : 0;
      if (ply >= maxMoves) {
        return false;
      }
    }
    // 思考中の場合は停止
    if (this.isThinking) {
      await this.stopAndWait();
    }
    return searchBookMovesForPlayer(
      this._sessionID,
      this.position,
      this.bookSessionID,
      this.name,
      {
        considerBookMoveCount: extraBook.considerBookMoveCount,
        turn: this.position.color,
        minEvalBlack: extraBook.minEvalBlack,
        minEvalWhite: extraBook.minEvalWhite,
        maxEvalDiff: extraBook.maxEvalDiff,
        ignoreRate: extraBook.ignoreRate,
        bookDepthLimit: extraBook.bookDepthLimit,
      },
      this.currentSfen,
      (move) => {
        const handler = this.handler;
        this.handler = undefined;
        if (handler) {
          handler.onMove(move);
        }
      },
    );
  }

  private async stopAndWait(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = new Promise((resolve, reject) => {
      this.stopPromiseResolver = resolve;
      this.stopPromiseRejector = reject;
      this.stopPromiseTimeoutId = window.setTimeout(() => {
        this.rejectStopPromise(new Error("Timed out waiting for stop acknowledgement"));
      }, STOP_WAIT_TIMEOUT_MS);
      this.lanEngine.sendCommand("stop");
    });

    return this.stopPromise;
  }

  private onMessage(message: string): void {
    // Expected format from server: {"sfen":"...","info":"bestmove ..."}
    try {
      const data = JSON.parse(message);
      if (data.error) {
        this.clearReadyReplayTimeout();
        const error = new Error(data.error);
        this.rejectStopPromise(error);
        if (this.handler) {
          this.handler.onError(error);
        } else if (this.onErrorCallback) {
          this.onErrorCallback(error);
        } else {
          console.error("LAN Engine Error:", data.error);
        }
        return;
      }

      if (data.info) {
        const infoStr = data.info as string;
        if (infoStr.startsWith("bestmove")) {
          this.clearReadyReplayTimeout();
          if (this.stopPromiseResolver || data.sfen === this.currentSfen) {
            this.isThinking = false;
          }
          this.resolveStopPromise();

          if (data.sfen === this.currentSfen) {
            this.flushInfo();
          } else {
            this.clearPendingInfo();
          }

          if (this.handler && this.position && data.sfen === this.currentSfen) {
            const parts = infoStr.split(" ");
            if (parts[1] === "resign") {
              this.handler.onResign();
              return;
            }
            const move = this.position.createMoveByUSI(parts[1]);
            if (move) {
              const delay = data.delay as number | undefined;
              const baseInfo = this.info || { usi: this.currentSfen };
              const infoWithDelay = delay ? { ...baseInfo, delay } : baseInfo;

              if (this.info?.pv && this.info.pv.length >= 1 && this.info.pv[0].equals(move)) {
                const info = {
                  ...infoWithDelay,
                  pv: this.info.pv.slice(1),
                };
                this.handler.onMove(move, info);
              } else {
                this.handler.onMove(move, delay ? infoWithDelay : undefined);
              }
            }
          }
        } else if (infoStr.startsWith("info") && this.position) {
          // Parse info string for research
          const infoCommand = parseInfoCommand(infoStr);
          this.updateInfo(infoCommand, data.sfen);
        }
      } else if (data.state) {
        if (data.state === "thinking") {
          this.clearReadyReplayTimeout();
          this.isThinking = true;
        }
        if (
          this.isThinking &&
          (data.state === "uninitialized" || data.state === "stopped" || data.state === "ready")
        ) {
          // If the engine is not thinking (uninitialized, stopped, or ready) but the client expects it to be,
          // it means the session was lost, the process crashed, or the state is inconsistent.
          // We should NOT automatically restart to avoid losing the search tree/hash silently.

          // Exception: If state is 'ready', it might be that we just connected and 'bestmove' is coming in the replay buffer.
          // However, server sends 'state' BEFORE replay buffer.
          // If we treat 'ready' as error immediately, we might kill the session before processing 'bestmove'.
          // So we should ignore 'ready' here and let the replay buffer handle it.
          // If 'bestmove' never comes, we will timeout eventually or user will stop manually.

          if (data.state === "ready") {
            this.scheduleReadyReplayTimeout();
            return;
          }

          this.clearReadyReplayTimeout();
          this.lanEngine.disconnect();

          const error = new Error(
            data.state === "uninitialized"
              ? t.researchStoppedBecauseLanDisconnected
              : t.engineProcessWasClosedUnexpectedly,
          );
          if (this.handler) {
            this.handler.onError(error);
          } else if (this.onErrorCallback) {
            this.onErrorCallback(error);
          }
          this.isThinking = false;
          this.rejectStopPromise(new Error("Engine stopped"));
        }
      }
    } catch {
      // Ignore non-JSON messages or parse errors
    }
  }

  private updateInfo(infoCommand: USIInfoCommand, sfen?: string) {
    if (!this.position || !this.onSearchInfo) return;

    // Check if the received USI command matches the current command.
    if (sfen !== this.currentSfen) {
      return;
    }

    // Validate if the PV/currmove is applicable to the current position.
    // This prevents processing "chimera packets" where the server attributes a new SFEN to an old engine output.
    const pvToValidate =
      infoCommand.pv && infoCommand.pv.length >= 1
        ? infoCommand.pv
        : infoCommand.currmove
          ? [infoCommand.currmove]
          : undefined;
    if (pvToValidate && pvToValidate.length > 0) {
      const move = this.position.createMoveByUSI(pvToValidate[0]);
      if (!move) {
        return;
      }
    }

    dispatchUSIInfoUpdate(this.sessionID, this.position, this.name, infoCommand);

    if (infoCommand.multipv && infoCommand.multipv !== 1) {
      return;
    }

    const sign = this.position.color === Color.BLACK ? 1 : -1;
    const pv = pvToValidate;

    // Only update if we have meaningful data
    if (
      !infoCommand.depth &&
      !infoCommand.nodes &&
      !infoCommand.scoreCP &&
      !infoCommand.scoreMate &&
      !pv
    ) {
      return;
    }

    const parsedPv = pv ? parseUSIPV(this.position, pv) : undefined;
    const resolvedPv = parsedPv && parsedPv.length > 0 ? parsedPv : undefined;

    this.info = {
      usi: this.currentSfen,
      depth: infoCommand.depth ?? this.info?.depth,
      nodes: infoCommand.nodes ?? this.info?.nodes,
      score:
        (infoCommand.scoreCP !== undefined ? infoCommand.scoreCP * sign : undefined) ??
        this.info?.score,
      mate:
        (infoCommand.scoreMate !== undefined ? infoCommand.scoreMate * sign : undefined) ??
        this.info?.mate,
      lowerBound: infoCommand.lowerbound ?? this.info?.lowerBound,
      upperBound: infoCommand.upperbound ?? this.info?.upperBound,
      pv: resolvedPv ?? this.info?.pv,
    };

    if (this.usiInfoTimeout) {
      return;
    }
    this.usiInfoTimeout = window.setTimeout(() => {
      this.flushInfo();
    }, 500);
  }

  private clearPendingInfo() {
    if (this.usiInfoTimeout) {
      clearTimeout(this.usiInfoTimeout);
      this.usiInfoTimeout = undefined;
    }
    this.info = undefined;
  }

  private handleTransportDisconnect() {
    this.clearReadyReplayTimeout();
    if (this.stopPromiseRejector) {
      this.isThinking = false;
      this.rejectStopPromise(new Error("Engine connection was lost while stopping"));
    }
  }

  private clearStopPromiseTimeout() {
    if (this.stopPromiseTimeoutId !== null) {
      clearTimeout(this.stopPromiseTimeoutId);
      this.stopPromiseTimeoutId = null;
    }
  }

  private clearReadyReplayTimeout() {
    if (this.readyReplayTimeoutId !== null) {
      clearTimeout(this.readyReplayTimeoutId);
      this.readyReplayTimeoutId = null;
    }
  }

  private resolveStopPromise() {
    const resolver = this.stopPromiseResolver;
    this.stopPromiseResolver = null;
    this.stopPromiseRejector = null;
    this.stopPromise = null;
    this.clearStopPromiseTimeout();
    resolver?.();
  }

  private rejectStopPromise(error: Error) {
    const rejector = this.stopPromiseRejector;
    this.stopPromiseResolver = null;
    this.stopPromiseRejector = null;
    this.stopPromise = null;
    this.clearStopPromiseTimeout();
    rejector?.(error);
  }

  private scheduleReadyReplayTimeout() {
    this.clearReadyReplayTimeout();
    this.readyReplayTimeoutId = window.setTimeout(() => {
      this.readyReplayTimeoutId = null;
      if (!this.isThinking) {
        return;
      }

      const error = new Error(t.engineProcessWasClosedUnexpectedly);
      this.isThinking = false;
      this.rejectStopPromise(error);
      if (this.handler) {
        this.handler.onError(error);
      } else if (this.onErrorCallback) {
        this.onErrorCallback(error);
      }
    }, READY_REPLAY_TIMEOUT_MS);
  }

  private flushInfo() {
    if (this.usiInfoTimeout) {
      clearTimeout(this.usiInfoTimeout);
      this.usiInfoTimeout = undefined;
    }
    if (this.info && this.info.usi === this.currentSfen) {
      this.onSearchInfo?.(this.info);
    }
  }
}
