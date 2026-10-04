import { Color, formatCSAMove, formatKIFMove, formatPV, type ImmutablePosition } from "tsshogi";
import { SCORE_MATE_INFINITE } from "@/common/game/usi";
import { getSituationText } from "@/common/game/score";
import { CommentBehavior, SearchCommentFormat } from "@/common/settings/comment";
import { SearchInfoSenderType, type SearchInfo } from "./types";

export function applyComment(original: string, add: string, behavior: CommentBehavior): string {
  if (!add || behavior === CommentBehavior.NONE) return original;
  const separator = original ? "\n" : "";
  if (behavior === CommentBehavior.INSERT) return add + separator + original;
  if (behavior === CommentBehavior.APPEND) return original + separator + add;
  return add;
}

export function buildSearchComment(
  position: ImmutablePosition,
  type: SearchInfoSenderType,
  format: SearchCommentFormat,
  info: SearchInfo,
  options?: { header?: string; engineName?: string },
): string {
  let comment = "";
  if (format === SearchCommentFormat.SHOGIHOME) {
    const prefix = type === SearchInfoSenderType.PLAYER ? "*" : "#";
    if (info.mate) {
      comment += `${prefix}詰み=${info.mate >= 0 ? "先手勝ち" : "後手勝ち"}`;
      if (Math.abs(info.mate) !== SCORE_MATE_INFINITE) comment += `:${Math.abs(info.mate)}手`;
      comment += "\n";
    }
    if (info.score !== undefined)
      comment += `${getSituationText(info.score)}\n${prefix}評価値=${info.score}\n`;
    if (info.pv?.length) comment += `${prefix}読み筋=${formatPV(position, info.pv)}\n`;
    if (info.depth) comment += `${prefix}深さ=${info.depth}\n`;
    if (info.nodes) comment += `${prefix}ノード数=${info.nodes}\n`;
    if (comment && options?.engineName) comment += `${prefix}エンジン=${options.engineName}\n`;
  } else if (format === SearchCommentFormat.SHOGIGUI) {
    comment = `*${type === SearchInfoSenderType.PLAYER ? "対局" : "解析"}`;
    if (info.depth !== undefined) comment += ` 深さ ${info.depth}`;
    if (info.nodes !== undefined) comment += ` ノード数 ${info.nodes}`;
    if (info.score !== undefined) comment += ` 評価値 ${info.score}`;
    else if (info.mate !== undefined) comment += ` 評価値 ${info.mate > 0 ? 30000 : -30000}`;
    if (info.pv?.length) {
      comment += " 読み筋";
      for (const move of info.pv)
        comment += ` ${move.color === Color.BLACK ? "▲" : "△"}${formatKIFMove(move)}`;
    }
  } else {
    const score = info.mate !== undefined ? (info.mate > 0 ? 30000 : -30000) : (info.score ?? 0);
    comment = `* ${score}`;
    for (const move of info.pv ?? []) comment += " " + formatCSAMove(move);
    if (format === SearchCommentFormat.CSA3 && info.nodes !== undefined)
      comment += ` #${info.nodes}`;
  }
  return options?.header ? options.header + "\n" + comment : comment;
}
