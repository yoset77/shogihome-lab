import { InitialPositionSFEN, Move, type ImmutableNode, type ImmutableRecord } from "tsshogi";
import { normalizeSfen } from "@/common/usi/sfen";

export interface SfenExportOptions {
  targetSfen?: string;
  maxMoves?: number;
  standardInitialOnly?: boolean;
}

export function isStandardInitialRecord(record: ImmutableRecord): boolean {
  return record.initialPosition.sfen === InitialPositionSFEN.STANDARD;
}

interface TraversalState {
  node: ImmutableNode;
  moves: string[];
  matchedTarget: boolean;
}

export function* generateSfenLines(
  record: ImmutableRecord,
  options: SfenExportOptions = {},
): Generator<string> {
  const initialSfen = record.initialPosition.sfen;
  const isStandardInitial = isStandardInitialRecord(record);
  if (options.standardInitialOnly && !isStandardInitial) {
    return;
  }

  const targetSfen = options.targetSfen ? normalizeSfen(options.targetSfen) : undefined;
  const prefix = isStandardInitial ? "position startpos" : `position sfen ${initialSfen}`;
  const rootMatches = targetSfen === undefined || normalizeSfen(record.first.sfen) === targetSfen;
  const stack: TraversalState[] = [{ node: record.first, moves: [], matchedTarget: rootMatches }];
  const truncatedLines = options.maxMoves === undefined ? undefined : new Set<string>();

  while (stack.length > 0) {
    const state = stack.pop()!;
    const moves =
      state.node.move instanceof Move ? [...state.moves, state.node.move.usi] : state.moves;
    const matchedTarget =
      state.matchedTarget ||
      (targetSfen !== undefined && normalizeSfen(state.node.sfen) === targetSfen);
    const reachedLimit = options.maxMoves !== undefined && moves.length >= options.maxMoves;
    const truncated = reachedLimit && state.node.next !== null;

    if (reachedLimit || !state.node.next) {
      if (matchedTarget) {
        const line = moves.length > 0 ? `${prefix} moves ${moves.join(" ")}` : prefix;
        if (!truncated || !truncatedLines?.has(line)) {
          if (truncated) truncatedLines?.add(line);
          yield line;
        }
      }
      continue;
    }

    const children: ImmutableNode[] = [];
    let child: ImmutableNode | null = state.node.next;
    while (child) {
      children.push(child);
      child = child.branch;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], moves, matchedTarget });
    }
  }
}
