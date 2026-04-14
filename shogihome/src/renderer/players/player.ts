import { GameResult } from "@/common/game/result.js";
import { TimeStates } from "@/common/game/time.js";
import { ImmutablePosition, Move } from "tsshogi";

export type SearchInfo = {
  usi: string; // 局面
  depth?: number; // 探索深さ
  nodes?: number; // 探索ノード数
  score?: number; // 先手から見た評価値
  mate?: number; // 先手勝ちの場合に正の値、後手勝ちの場合に負の値
  lowerBound?: boolean; // 評価値が下限値（以上）である
  upperBound?: boolean; // 評価値が上限値（以下）である
  pv?: Move[];
  delay?: number; // サーバーからの送信遅延(ms)
};

export interface SearchHandler {
  onMove: (move: Move, info?: SearchInfo) => void;
  onResign: () => void;
  onWin: () => void;
  onError: (e: unknown) => void;
}

export interface MateHandler {
  onCheckmate: (moves: Move[]) => void;
  onNotImplemented: () => void;
  onTimeout: () => void;
  onNoMate: () => void;
  onError: (e: unknown) => void;
}

export interface Player {
  isEngine(): boolean;
  readyNewGame(): Promise<void>;
  startSearch(
    position: ImmutablePosition,
    usi: string,
    timeStates: TimeStates,
    handler: SearchHandler,
  ): Promise<void>;
  startPonder(position: ImmutablePosition, usi: string, timeStates: TimeStates): Promise<void>;
  startMateSearch(
    position: ImmutablePosition,
    usi: string,
    maxSeconds: number | undefined,
    handler: MateHandler,
  ): Promise<void>;
  stop(): Promise<void>;
  gameover(result: GameResult): Promise<void>;
  close(): Promise<void>;
}
