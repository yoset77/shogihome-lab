import type { ImmutableNode } from "tsshogi";
import { normalizeSfen } from "@/common/usi/sfen";

// Keep indexing and navigation in the same first-occurrence, depth-first order.
export function* iterateKifuNodes(first: ImmutableNode) {
  const stack = [{ node: first, isVariation: false }];
  const visited = new Set<ImmutableNode>();
  while (stack.length) {
    const entry = stack.pop()!;
    if (visited.has(entry.node)) continue;
    visited.add(entry.node);
    yield entry;
    if (entry.node.branch) stack.push({ node: entry.node.branch, isVariation: true });
    if (entry.node.next) {
      stack.push({ node: entry.node.next, isVariation: entry.isVariation });
    }
  }
}

export function findKifuPosition(
  first: ImmutableNode,
  ply: number,
  sfen?: string,
): ImmutableNode | undefined {
  for (const { node } of iterateKifuNodes(first)) {
    if (node.ply === ply && (!sfen || normalizeSfen(node.sfen) === sfen)) return node;
  }
}
