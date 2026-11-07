import type { USIInfoCommand } from "@/common/game/usi";

export function mergeAnalysisInfo(
  current: USIInfoCommand | undefined,
  incoming: USIInfoCommand,
): USIInfoCommand | null {
  const hasScore = incoming.scoreCP !== undefined || incoming.scoreMate !== undefined;
  const hasInvalidBound =
    (incoming.lowerbound && incoming.upperbound) ||
    ((incoming.lowerbound || incoming.upperbound) && !hasScore);
  // Analysis DB accumulation only accepts depth-bearing updates with consistent bounds.
  if (incoming.depth === undefined || hasInvalidBound) return null;

  // Merge with previous to keep nodes/time if omitted in this line.
  const nextInfo = { ...current, ...incoming };
  if (hasScore) {
    // Score kind and bound describe one atomic USI score update.
    nextInfo.scoreCP = incoming.scoreCP;
    nextInfo.scoreMate = incoming.scoreMate;
    nextInfo.lowerbound = incoming.lowerbound;
    nextInfo.upperbound = incoming.upperbound;
  }
  return nextInfo;
}

export function selectAnalysisInfosForSave(
  infos: ReadonlyMap<number, USIInfoCommand>,
  minDepth: number,
): Map<number, USIInfoCommand> {
  const validInfos = new Map<number, USIInfoCommand>();
  const savedMoves = new Set<string>();
  const sortedInfos = [...infos.entries()].sort(([a], [b]) => a - b);
  for (const [multipv, info] of sortedInfos) {
    if (info.depth === undefined || info.depth < minDepth) continue;

    const firstMove = info.pv?.[0];
    if (firstMove && savedMoves.has(firstMove)) continue;
    if (firstMove) savedMoves.add(firstMove);
    validInfos.set(multipv, info);
  }
  return validInfos;
}
