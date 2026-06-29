import type { Move } from "tsshogi";

export type SearchInfo = {
  depth?: number;
  nodes?: number;
  score?: number;
  mate?: number;
  lowerBound?: boolean;
  upperBound?: boolean;
  pv?: Move[];
};

export type RecordCustomData = {
  playerSearchInfo?: SearchInfo;
  opponentSearchInfo?: SearchInfo;
  researchInfo?: SearchInfo;
  researchInfo2?: SearchInfo;
  researchInfo3?: SearchInfo;
  researchInfo4?: SearchInfo;
};

export enum SearchInfoSenderType {
  PLAYER,
  OPPONENT,
  RESEARCHER,
  RESEARCHER_2,
  RESEARCHER_3,
  RESEARCHER_4,
}
