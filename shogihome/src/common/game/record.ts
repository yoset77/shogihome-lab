import {
  Record,
  RecordMetadataKey,
  Position,
  initialPositionTypeToSFEN,
  type InitialPositionType,
  type ImmutableNode,
  type Move,
  type SpecialMove,
  type SpecialMoveType,
  type DoMoveOption,
} from "tsshogi";
import { getDateString, getDateTimeString } from "@/common/helpers/datetime";
import { secondsToMMSS } from "@/common/helpers/time";
import type { TimeLimitSettings } from "@/common/settings/game";
import { applyComment, buildSearchComment } from "@/common/record/search_comment";
import { CommentBehavior, SearchCommentFormat } from "@/common/settings/comment";
import {
  SearchInfoSenderType,
  type RecordCustomData,
  type SearchInfo,
} from "@/common/record/types";

export type GameRecordCheckpoint = {
  node: ImmutableNode;
  children: { node: ImmutableNode; comment: string; customData: unknown; elapsedMs: number }[];
  customData: unknown;
};

/** Mutable game record; transport snapshots never expose these node references. */
export class GameRecord {
  constructor(public record = new Record()) {}

  resetByInitialPositionType(type: InitialPositionType): void {
    this.record = new Record(Position.newBySFEN(initialPositionTypeToSFEN(type))!);
  }
  resetBySFEN(sfen: string): boolean {
    const position = Position.newBySFEN(sfen);
    if (!position) return false;
    this.record = new Record(position);
    return true;
  }
  changePly(ply: number): void {
    this.record.goto(ply);
  }
  removeNextMove(): void {
    this.record.removeNextMove();
  }
  importRecord(usi: string): void {
    const record = Record.newByUSI(usi);
    if (!(record instanceof Record)) throw record;
    this.record = record;
  }
  updateComment(comment: string): void {
    this.record.current.comment = comment;
  }
  appendMove(params: {
    move: Move | SpecialMove | SpecialMoveType;
    moveOption?: DoMoveOption;
    elapsedMs?: number;
  }): void {
    if (!this.record.append(params.move, params.moveOption)) throw new Error("Invalid game move");
    this.record.current.setElapsedMs(params.elapsedMs ?? 0);
  }
  createGameCheckpoint(): GameRecordCheckpoint {
    const children: GameRecordCheckpoint["children"] = [];
    for (let node = this.record.current.next; node; node = node.branch)
      children.push({
        node,
        comment: node.comment,
        customData: node.customData && { ...(node.customData as object) },
        elapsedMs: node.elapsedMs,
      });
    return {
      node: this.record.current,
      children,
      customData: this.record.current.customData && {
        ...(this.record.current.customData as object),
      },
    };
  }
  rollbackGameMoves(checkpoints: GameRecordCheckpoint[], restoreClocks: () => void): void {
    let node: ImmutableNode = this.record.current;
    for (const checkpoint of [...checkpoints].reverse()) {
      if (node.prev !== checkpoint.node) throw new Error("Invalid game rollback path");
      node = checkpoint.node;
    }
    for (const checkpoint of [...checkpoints].reverse()) {
      const current = this.record.current;
      const existing = checkpoint.children.find((child) => child.node === current);
      if (existing) {
        current.comment = existing.comment;
        current.customData = existing.customData;
        current.setElapsedMs(existing.elapsedMs);
        this.record.gotoNode(checkpoint.node);
      } else {
        this.record.removeCurrentMove();
        this.record.gotoNode(checkpoint.node);
      }
      this.record.current.customData = checkpoint.customData;
    }
    restoreClocks();
  }
  updateSearchInfo(type: SearchInfoSenderType, info: SearchInfo): void {
    const key = type === SearchInfoSenderType.PLAYER ? "playerSearchInfo" : "opponentSearchInfo";
    this.record.current.customData = {
      ...((this.record.current.customData ?? {}) as RecordCustomData),
      [key]: info,
    };
  }
  appendSearchComment(
    type: SearchInfoSenderType,
    format: SearchCommentFormat,
    info: SearchInfo,
    behavior: CommentBehavior,
    options: { engineName: string },
  ): void {
    const comment = applyComment(
      this.record.current.comment,
      buildSearchComment(this.record.position, type, format, info, options),
      behavior,
    );
    if (comment.length > 65_536) throw new Error("Game comment capacity exceeded");
    this.record.current.comment = comment;
  }
  setGameStartMetadata(metadata: {
    gameTitle?: string;
    blackName?: string;
    whiteName?: string;
    blackTimeLimit: TimeLimitSettings;
    whiteTimeLimit: TimeLimitSettings;
  }): void {
    const data = this.record.metadata;
    if (metadata.gameTitle) data.setStandardMetadata(RecordMetadataKey.TITLE, metadata.gameTitle);
    if (metadata.blackName)
      data.setStandardMetadata(RecordMetadataKey.BLACK_NAME, metadata.blackName);
    if (metadata.whiteName)
      data.setStandardMetadata(RecordMetadataKey.WHITE_NAME, metadata.whiteName);
    data.setStandardMetadata(RecordMetadataKey.DATE, getDateString());
    data.setStandardMetadata(RecordMetadataKey.START_DATETIME, getDateTimeString());
    const v3 = metadata.blackTimeLimit.increment || metadata.whiteTimeLimit.increment;
    const format = (time: TimeLimitSettings) =>
      v3
        ? `${time.timeSeconds}+${time.byoyomi}+${time.increment}`
        : `${secondsToMMSS(time.timeSeconds)}+${String(time.byoyomi).padStart(2, "0")}`;
    const black = format(metadata.blackTimeLimit),
      white = format(metadata.whiteTimeLimit);
    if (black === white) data.setStandardMetadata(RecordMetadataKey.TIME_LIMIT, black);
    else {
      data.setStandardMetadata(RecordMetadataKey.BLACK_TIME_LIMIT, black);
      data.setStandardMetadata(RecordMetadataKey.WHITE_TIME_LIMIT, white);
    }
  }
  setGameEndMetadata(): void {
    this.record.metadata.setStandardMetadata(RecordMetadataKey.END_DATETIME, getDateTimeString());
  }
}
