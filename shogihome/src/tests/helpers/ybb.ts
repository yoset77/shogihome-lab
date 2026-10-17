import { Position } from "tsshogi";
import { sfenToPackedSfen } from "@/server/book/packed_sfen";
import { toYaneMove16 } from "@/server/book/yane_move";

type MoveReference = {
  sfen?: string;
  moveCount: number;
  moveOffset?: number;
};

export function createYbbWithReferences(
  records: MoveReference[],
  moveEntries: number,
  hasDepth = false,
): Buffer {
  const entrySize = hasDepth ? 6 : 4;
  const movesStart = 32 + records.length * 44;
  const data = Buffer.alloc(movesStart + moveEntries * entrySize);
  data.write("YANE-BINBOOK-V1\0", 0, "ascii");
  data.writeBigUInt64LE(BigInt(records.length), 16);
  data.writeBigUInt64LE(hasDepth ? 1n : 0n, 24);
  const startpos = new Position().sfen;
  const sorted = records.map((record) => ({
    ...record,
    packed: Buffer.from(sfenToPackedSfen(record.sfen ?? startpos).buffer),
  }));
  sorted.sort((a, b) => a.packed.compare(b.packed));
  for (const [index, record] of sorted.entries()) {
    const offset = 32 + index * 44;
    record.packed.copy(data, offset);
    data.writeBigUInt64LE(BigInt((record.moveOffset ?? 0) * entrySize), offset + 32);
    data.writeUInt16LE(1, offset + 40);
    data.writeUInt16LE(record.moveCount, offset + 42);
  }
  for (let index = 0; index < moveEntries; index++) {
    data.writeUInt16LE(toYaneMove16("5i5h"), movesStart + index * entrySize);
  }
  return data;
}

export function createDistinctYbbPositions(count: number): string[] {
  const positions: string[] = [];
  for (let a = 1; a <= 9; a++) {
    for (let b = a + 1; b <= 9; b++) {
      for (let c = 1; c <= 9; c++) {
        for (let d = c + 1; d <= 9; d++) {
          const position = new Position();
          for (const usi of [`${a}g${a}f`, `${c}c${c}d`, `${b}g${b}f`, `${d}c${d}d`]) {
            const move = position.createMoveByUSI(usi);
            if (!move || !position.isValidMove(move) || !position.doMove(move)) {
              throw new Error("Cannot generate a legal YBB fixture position");
            }
          }
          positions.push(position.sfen);
          if (positions.length === count) return positions;
        }
      }
    }
  }
  throw new Error("Too many YBB fixture positions requested");
}
