import { Color, ImmutablePosition, Move } from "tsshogi";
import type { SearchInfo } from "./player";

// SCORE_MATE_INFINITE は詰みを発見したが手数までは確定していない場合に使用する値です。
export const SCORE_MATE_INFINITE = 10000;

export type ScoreBound = "exact" | "lower" | "upper";

export type USIInfoCommand = {
  depth?: number;
  seldepth?: number;
  timeMs?: number;
  nodes?: number;
  pv?: string[];
  multipv?: number;
  scoreCP?: number;
  scoreMate?: number;
  lowerbound?: boolean;
  upperbound?: boolean;
  currmove?: string;
  hashfullPerMill?: number;
  nps?: number;
  string?: string;
};

export function toBlackSearchScore(
  info: USIInfoCommand,
  color: Color,
): Pick<SearchInfo, "score" | "mate" | "lowerBound" | "upperBound"> {
  // Score-less updates must preserve the previous evaluation when merged.
  if (info.scoreCP === undefined && info.scoreMate === undefined) return {};
  const sign = color === Color.BLACK ? 1 : -1;
  return {
    score: info.scoreCP === undefined ? undefined : info.scoreCP === 0 ? 0 : info.scoreCP * sign,
    mate: info.scoreMate === undefined ? undefined : info.scoreMate * sign,
    lowerBound: color === Color.BLACK ? info.lowerbound : info.upperbound,
    upperBound: color === Color.BLACK ? info.upperbound : info.lowerbound,
  };
}

export function parseUSIPV(position: ImmutablePosition, usiPv: string[]): Move[] {
  const pv: Move[] = [];
  const pos = position.clone();
  for (const usiMove of usiPv) {
    const move = pos.createMoveByUSI(usiMove);
    if (!move || !pos.doMove(move)) {
      break;
    }
    pv.push(move);
  }
  return pv;
}

function parseScoreMate(arg: string): number {
  switch (arg) {
    case "+":
    case "+0":
    case "0":
      return +SCORE_MATE_INFINITE;
    case "-":
    case "-0":
      return -SCORE_MATE_INFINITE;
    default:
      return Number(arg);
  }
}

export function parseInfoCommand(infoStr: string): USIInfoCommand {
  const result: USIInfoCommand = {};
  const s = infoStr.split(" ");
  const start = s[0] === "info" ? 1 : 0;
  for (let i = start; i < s.length; i += 1) {
    switch (s[i]) {
      case "depth":
        result.depth = Number(s[i + 1]);
        i += 1;
        break;
      case "seldepth":
        result.seldepth = Number(s[i + 1]);
        i += 1;
        break;
      case "time":
        result.timeMs = Number(s[i + 1]);
        i += 1;
        break;
      case "nodes":
        result.nodes = Number(s[i + 1]);
        i += 1;
        break;
      case "pv":
        result.pv = s.slice(i + 1);
        i = s.length;
        break;
      case "multipv":
        result.multipv = Number(s[i + 1]);
        i += 1;
        break;
      case "score":
        switch (s[i + 1]) {
          case "cp":
            result.scoreCP = Number(s[i + 2]);
            i += 2;
            break;
          case "mate":
            result.scoreMate = parseScoreMate(s[i + 2]);
            i += 2;
            break;
        }
        break;
      case "lowerbound":
        result.lowerbound = true;
        break;
      case "upperbound":
        result.upperbound = true;
        break;
      case "currmove":
        result.currmove = s[i + 1];
        i += 1;
        break;
      case "hashfull":
        result.hashfullPerMill = Number(s[i + 1]);
        i += 1;
        break;
      case "nps":
        result.nps = Number(s[i + 1]);
        i += 1;
        break;
      case "string":
        result.string = s.slice(i + 1).join(" ");
        i = s.length;
        break;
    }
  }
  return result;
}
