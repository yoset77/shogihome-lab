import { ImmutablePosition, Move, formatMove } from "tsshogi";

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

  for (const usiMove of pv) {
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
  const hasUnreadTail =
    parsedPv.length > maxMoves || (parsedPv.length > 0 && parsedPv.length < pv.length);
  if (hasUnreadTail) {
    text += " ...";
  }

  return {
    parsedPv,
    text,
  };
}
