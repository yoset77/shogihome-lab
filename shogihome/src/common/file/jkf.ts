import { importJKF, type JKF, type Record as ShogiRecord } from "tsshogi";
import { t } from "@/common/i18n";

export const MAX_JKF_BYTES = 10 * 1024 * 1024;
export const MAX_JKF_NODES = 10_000;
export const MAX_JKF_FORKS = 10_000;
export const MAX_JKF_DEPTH = 64;
export const MAX_JKF_PLY = 2_048;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Validate traversal containers before tsshogi can allocate from their lengths.
// Move and initial-position semantics remain owned by tsshogi.
function validateTraversal(value: unknown): JKF {
  if (!isObject(value) || !isObject(value.header) || !Array.isArray(value.moves))
    throw new Error(t.invalidJKFStructure);
  if (Object.values(value.header).some((entry) => typeof entry !== "string"))
    throw new Error(t.invalidJKFStructure);

  const stack = [{ moves: value.moves as unknown[], ply: 0, depth: 0 }];
  let nodes = value.moves.length;
  let forks = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (nodes > MAX_JKF_NODES || forks > MAX_JKF_FORKS || entry.depth > MAX_JKF_DEPTH)
      throw new Error(t.jkfImportLimit);
    let ply = entry.ply;
    for (const move of entry.moves) {
      if (!isObject(move)) throw new Error(t.invalidJKFStructure);
      if (move.comments != null) {
        if (
          !Array.isArray(move.comments) ||
          move.comments.some((comment) => typeof comment !== "string")
        )
          throw new Error(t.invalidJKFStructure);
      }
      if (move.move != null && !isObject(move.move)) throw new Error(t.invalidJKFStructure);
      if (move.special != null && typeof move.special !== "string")
        throw new Error(t.invalidJKFStructure);
      if (move.time != null && !isObject(move.time)) throw new Error(t.invalidJKFStructure);
      if (move.forks != null) {
        if (!Array.isArray(move.forks)) throw new Error(t.invalidJKFStructure);
        forks += move.forks.length;
        if (forks > MAX_JKF_FORKS) throw new Error(t.jkfImportLimit);
        for (const branch of move.forks) {
          if (!Array.isArray(branch)) throw new Error(t.invalidJKFStructure);
          nodes += branch.length;
          if (nodes > MAX_JKF_NODES || entry.depth >= MAX_JKF_DEPTH)
            throw new Error(t.jkfImportLimit);
          stack.push({ moves: branch, ply, depth: entry.depth + 1 });
        }
      }
      ply += Number(!!move.move) + Number(!!move.special);
      if (ply > MAX_JKF_PLY) throw new Error(t.jkfImportLimit);
    }
  }
  return value as JKF;
}

export function importJKFSafely(text: string): ShogiRecord | Error {
  try {
    if (text.length > MAX_JKF_BYTES || new TextEncoder().encode(text).byteLength > MAX_JKF_BYTES)
      return new Error(t.jkfImportLimit);
    return importJKF(validateTraversal(JSON.parse(text)));
  } catch (error) {
    return error instanceof SyntaxError
      ? new Error(t.invalidJKFStructure)
      : error instanceof Error
        ? error
        : new Error(t.invalidJKFStructure);
  }
}
