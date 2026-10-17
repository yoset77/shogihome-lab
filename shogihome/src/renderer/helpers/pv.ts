import { ImmutablePosition, Move, formatMove } from "tsshogi";
import { isUSIPVEnd, type USIPVEnd } from "@/common/game/usi";
import { t } from "@/common/i18n";

export type FormattedPV = {
  parsedPv: Move[];
  text: string;
};

export function formatDisplayPV(
  position: ImmutablePosition,
  pv: string[] | null | undefined,
  maxMoves: number,
): FormattedPV {
  if (!pv || pv.length === 0) {
    return {
      parsedPv: [],
      text: "",
    };
  }

  const pos = position.clone();
  const parsedPv: Move[] = [];
  const moveTexts: string[] = [];
  let lastMove: Move | undefined;
  let end: USIPVEnd | undefined;

  for (const [index, usiMove] of pv.entries()) {
    if (index === pv.length - 1 && isUSIPVEnd(usiMove)) {
      end = usiMove;
      break;
    }
    const move = pos.createMoveByUSI(usiMove);
    if (!move) {
      break;
    }
    parsedPv.push(move);
    if (moveTexts.length < maxMoves) {
      moveTexts.push(formatMove(pos, move, { lastMove }));
    }
    pos.doMove(move, { ignoreValidation: true });
    lastMove = move;
  }

  let text = moveTexts.join("");
  const moveCount = pv.length - (end ? 1 : 0);
  const hasUnreadTail =
    parsedPv.length > maxMoves || (parsedPv.length > 0 && parsedPv.length < moveCount);
  if (hasUnreadTail) {
    text += " ...";
  }
  if (end) {
    const labels: Record<USIPVEnd, string> = {
      rep_draw: t.repetitionDraw,
      rep_win: t.perpetualCheckRepetition,
      rep_lose: t.perpetualCheckRepetition,
      rep_sup: t.superiorPosition,
      rep_inf: t.inferiorPosition,
      win: t.winByDeclaration,
      resign: t.resign,
    };
    text += (text ? " " : "") + t.pvEndLabel(labels[end]);
  }

  return {
    parsedPv,
    text,
  };
}
