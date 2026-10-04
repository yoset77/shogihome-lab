import {
  Color,
  Move,
  PieceType,
  Position,
  Record as ShogiRecord,
  RecordMetadataKey,
  SpecialMoveType,
  parseUSIMove,
  type ImmutableRecord,
  type ImmutableNode,
  type Node,
  type SpecialMove,
} from "tsshogi";
import type { DecodeResult } from "@/common/engine/relay_protocol";
import * as v from "@/common/analysis/validation";
import type { RecordCustomData, SearchInfo } from "./types";

export const MAX_SNAPSHOT_NODES = 10_000;
export const MAX_SNAPSHOT_PLY = 2_048;
export const MAX_SNAPSHOT_PV = 256;

export type MoveSnapshot = {
  usi: string;
  color: Color;
  pieceType: PieceType;
  capturedPieceType: PieceType | null;
};
export type SearchInfoSnapshot = Omit<SearchInfo, "pv"> & {
  pv?: MoveSnapshot[];
  usi?: string;
  delay?: number;
};
export type CustomDataSnapshot = Partial<{ [K in keyof RecordCustomData]: SearchInfoSnapshot }>;
export type NodeSnapshot = {
  id: string;
  parentId: string | null;
  move: string | SpecialMove;
  selectedChild: string | null;
  comment: string;
  bookmark: string;
  elapsedMs: number;
  customData: CustomDataSnapshot | null;
};
export type RecordSnapshot = {
  version: 1;
  initialSfen: string;
  nodes: NodeSnapshot[];
  currentId: string;
  selectedPath: string[];
  metadata: { standard: [RecordMetadataKey, string][]; custom: [string, string][] };
};

const dataKeys: (keyof RecordCustomData)[] = [
  "playerSearchInfo",
  "opponentSearchInfo",
  "researchInfo",
  "researchInfo2",
  "researchInfo3",
  "researchInfo4",
];

export function encodeSearchInfo(
  info: SearchInfo & { usi?: string; delay?: number },
): SearchInfoSnapshot {
  return {
    ...info,
    pv: info.pv?.map((move) => ({
      usi: move.usi,
      color: move.color,
      pieceType: move.pieceType,
      capturedPieceType: move.capturedPieceType,
    })),
  };
}

export function readSearchInfo(value: unknown): SearchInfoSnapshot {
  const input = v.object(value);
  const result: SearchInfoSnapshot = {};
  for (const key of ["depth", "nodes", "score", "mate", "delay"] as const) {
    if (input[key] !== undefined)
      result[key] = v.finite(
        input[key],
        key === "score" || key === "mate" ? -Number.MAX_SAFE_INTEGER : 0,
      );
  }
  for (const key of ["lowerBound", "upperBound"] as const) {
    if (input[key] !== undefined) result[key] = v.boolean(input[key]);
  }
  if (input.usi !== undefined) result.usi = v.text(input.usi, 32_768);
  if (input.pv !== undefined)
    result.pv = v.array(input.pv, MAX_SNAPSHOT_PV).map((item) => {
      const move = v.object(item);
      const usi = v.text(move.usi, 5);
      if (!parseUSIMove(usi)) throw new Error("Invalid PV move");
      return {
        usi,
        color: v.enumeration(move.color, Object.values(Color)),
        pieceType: v.enumeration(move.pieceType, Object.values(PieceType)),
        capturedPieceType:
          move.capturedPieceType === null
            ? null
            : v.enumeration(move.capturedPieceType, Object.values(PieceType)),
      };
    });
  return result;
}

export function restoreSearchInfo(info: SearchInfoSnapshot): SearchInfo {
  return {
    ...info,
    pv: info.pv?.map((move) => {
      const decoded = parseUSIMove(move.usi);
      if (!decoded) throw new Error("Invalid PV move");
      return new Move(
        decoded.from,
        decoded.to,
        decoded.promote,
        move.color,
        move.pieceType,
        move.capturedPieceType,
      );
    }),
  };
}

function readCustomData(value: unknown): CustomDataSnapshot | null {
  if (value === null) return null;
  const input = v.object(value);
  if (Object.keys(input).some((key) => !dataKeys.includes(key as keyof RecordCustomData)))
    throw new Error("Unsupported custom data");
  return Object.fromEntries(
    dataKeys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, readSearchInfo(input[key])]),
  ) as CustomDataSnapshot;
}

export function encodeCustomData(value: unknown): CustomDataSnapshot | null {
  if (value === undefined || value === null) return null;
  const input = v.object(value);
  if (Object.keys(input).some((key) => !dataKeys.includes(key as keyof RecordCustomData)))
    throw new Error("Unsupported custom data");
  return Object.fromEntries(
    dataKeys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, encodeSearchInfo(input[key] as SearchInfo)]),
  );
}

export function restoreCustomData(data: CustomDataSnapshot | null): RecordCustomData | undefined {
  return data === null
    ? undefined
    : Object.fromEntries(Object.entries(data).map(([key, info]) => [key, restoreSearchInfo(info)]));
}

export function indexRecordNodes(record: ImmutableRecord): Map<string, ImmutableNode> {
  const nodes: ImmutableNode[] = [];
  const pending = [record.first];
  while (pending.length) {
    const node = pending.pop()!;
    nodes.push(node);
    if (nodes.length > MAX_SNAPSHOT_NODES || node.ply > MAX_SNAPSHOT_PLY)
      throw new Error("Record is too large");
    const children: ImmutableNode[] = [];
    for (let child = node.next; child; child = child.branch) children.push(child);
    pending.push(...children.reverse());
  }
  return new Map(nodes.map((node, index) => [`n${index}`, node]));
}

export function snapshotRecord(record: ImmutableRecord): RecordSnapshot {
  const indexed = indexRecordNodes(record);
  const nodes = [...indexed.values()];
  const ids = new Map([...indexed].map(([id, node]) => [node, id]));
  return {
    version: 1,
    initialSfen: record.initialPosition.sfen,
    currentId: ids.get(record.current)!,
    selectedPath: record.moves.map((node) => ids.get(node)!),
    metadata: {
      standard: [...record.metadata.standardMetadataKeys].map((key) => [
        key,
        record.metadata.getStandardMetadata(key)!,
      ]),
      custom: [...record.metadata.customMetadataKeys].map((key) => [
        key,
        record.metadata.getCustomMetadata(key)!,
      ]),
    },
    nodes: nodes.map((node) => {
      let selected: ImmutableNode | null = node.next;
      while (selected && !selected.activeBranch) selected = selected.branch;
      return {
        id: ids.get(node)!,
        parentId: node.prev ? ids.get(node.prev)! : null,
        move: node.move instanceof Move ? node.move.usi : { ...node.move },
        selectedChild: selected ? ids.get(selected)! : null,
        comment: node.comment,
        bookmark: node.bookmark,
        elapsedMs: node.elapsedMs,
        customData: encodeCustomData(node.customData),
      };
    }),
  };
}

export function restoreRecord(snapshot: RecordSnapshot): {
  record: ShogiRecord;
  nodes: Map<string, Node>;
} {
  const initial = Position.newBySFEN(snapshot.initialSfen);
  if (!initial) throw new Error("Invalid initial SFEN");
  const record = new ShogiRecord(initial);
  const nodes = new Map<string, Node>();
  const siblingMoves = new Map<string, Set<string>>();
  for (const [index, input] of snapshot.nodes.entries()) {
    if (nodes.has(input.id)) throw new Error("Duplicate node ID");
    if (index === 0) {
      if (
        input.parentId !== null ||
        typeof input.move === "string" ||
        input.move.type !== SpecialMoveType.START
      )
        throw new Error("Invalid root");
    } else {
      const parent = input.parentId && nodes.get(input.parentId);
      if (
        !parent ||
        parent.ply >= MAX_SNAPSHOT_PLY ||
        (parent !== record.first && !(parent.move instanceof Move))
      )
        throw new Error("Invalid parent");
      if (record.current !== parent) record.gotoNode(parent);
      const key = JSON.stringify(input.move);
      const siblings = siblingMoves.get(input.parentId!) ?? new Set<string>();
      if (siblings.has(key)) throw new Error("Duplicate branch move");
      siblings.add(key);
      siblingMoves.set(input.parentId!, siblings);
      const move =
        typeof input.move === "string" ? record.position.createMoveByUSI(input.move) : input.move;
      if (
        !move ||
        (typeof move !== "string" &&
          !(move instanceof Move) &&
          move.type === SpecialMoveType.START) ||
        !record.append(move)
      )
        throw new Error("Invalid record move");
    }
    const node = record.current;
    node.comment = input.comment;
    node.bookmark = input.bookmark;
    node.setElapsedMs(input.elapsedMs);
    node.customData = restoreCustomData(input.customData);
    nodes.set(input.id, node);
  }
  for (const input of [...snapshot.nodes].reverse()) {
    const node = nodes.get(input.id)!;
    if (input.selectedChild === null) {
      if (node.next) throw new Error("Missing branch selection");
    } else {
      const child = nodes.get(input.selectedChild);
      if (!child || child.prev !== node) throw new Error("Invalid branch selection");
      if (!child.activeBranch) record.gotoNode(child);
    }
  }
  const path = record.moves;
  if (
    path.length !== snapshot.selectedPath.length ||
    path.some((node, i) => node !== nodes.get(snapshot.selectedPath[i]))
  )
    throw new Error("Invalid selected path");
  const current = nodes.get(snapshot.currentId);
  if (!current || !path.includes(current)) throw new Error("Invalid current node");
  record.gotoNode(current);
  for (const [key, value] of snapshot.metadata.standard)
    record.metadata.setStandardMetadata(key, value);
  for (const [key, value] of snapshot.metadata.custom)
    record.metadata.setCustomMetadata(key, value);
  return { record, nodes };
}

export function decodeRecordSnapshot(value: unknown): DecodeResult<RecordSnapshot> {
  try {
    const input = v.object(value);
    if (input.version !== 1) throw new Error("Unsupported snapshot version");
    const metadata = v.object(input.metadata);
    const snapshot: RecordSnapshot = {
      version: 1,
      initialSfen: v.text(input.initialSfen, 512),
      currentId: v.identifier(input.currentId),
      selectedPath: v.array(input.selectedPath, MAX_SNAPSHOT_PLY + 1).map(v.identifier),
      metadata: {
        standard: v.array(metadata.standard, 256).map((entry) => {
          const pair = v.array(entry, 2);
          if (pair.length !== 2) throw new Error("Invalid metadata");
          return [v.enumeration(pair[0], Object.values(RecordMetadataKey)), v.text(pair[1])];
        }),
        custom: v.array(metadata.custom, 256).map((entry) => {
          const pair = v.array(entry, 2);
          if (pair.length !== 2) throw new Error("Invalid metadata");
          return [v.text(pair[0], 256), v.text(pair[1])];
        }),
      },
      nodes: v.array(input.nodes, MAX_SNAPSHOT_NODES).map((item) => {
        const node = v.object(item);
        let move: string | SpecialMove;
        if (typeof node.move === "string") {
          move = v.text(node.move, 5);
          if (!parseUSIMove(move)) throw new Error("Invalid move");
        } else {
          const special = v.object(node.move);
          move =
            special.type === "any"
              ? { type: "any", name: v.text(special.name, 1024) }
              : { type: v.enumeration(special.type, Object.values(SpecialMoveType)) };
        }
        return {
          id: v.identifier(node.id),
          parentId: node.parentId === null ? null : v.identifier(node.parentId),
          selectedChild: node.selectedChild === null ? null : v.identifier(node.selectedChild),
          move,
          comment: v.text(node.comment),
          bookmark: v.text(node.bookmark, 1024),
          elapsedMs: v.finite(node.elapsedMs, 0),
          customData: readCustomData(node.customData),
        };
      }),
    };
    if (!snapshot.nodes.length) throw new Error("Empty record");
    for (const entries of [snapshot.metadata.standard, snapshot.metadata.custom]) {
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        throw new Error("Duplicate metadata key");
    }
    restoreRecord(snapshot);
    return { ok: true, value: snapshot };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid record snapshot" };
  }
}

/** Navigation is not an edit and must not invalidate result application. */
export function recordContent(snapshot: RecordSnapshot): string {
  return JSON.stringify(
    {
      initialSfen: snapshot.initialSfen,
      metadata: snapshot.metadata,
      nodes: snapshot.nodes.map((node) => {
        const content = { ...node };
        delete (content as Partial<NodeSnapshot>).selectedChild;
        return content;
      }),
    },
    (_key, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const object = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, object[key]]),
      );
    },
  );
}
