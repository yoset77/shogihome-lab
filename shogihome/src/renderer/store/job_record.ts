import { recordContent, type RecordSnapshot } from "@/common/record/snapshot";

// Compare what normal browser record recovery preserves, not server node identities.
export function jobRecordContent(source: RecordSnapshot): string {
  const ids = new Map(source.nodes.map((node, index) => [node.id, `n_${index}`]));
  return recordContent({
    ...source,
    nodes: source.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      parentId: node.parentId === null ? null : ids.get(node.parentId)!,
      elapsedMs: Math.floor(node.elapsedMs / 1000) * 1000,
      customData: null,
    })),
  });
}
