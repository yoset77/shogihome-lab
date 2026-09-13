import fs from "node:fs";
import { BookEntry, BookMove, YbbBook, mergeBookEntries } from "./types.js";
import { sfenToPackedSfen, packedSfenToSfen } from "./packed_sfen.js";
import { toYaneMove16, fromYaneMove16 } from "./yane_move.js";

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

if (!IS_LITTLE_ENDIAN) {
  throw new Error("Big-endian platforms are not supported");
}

const MAGIC = "YANE-BINBOOK-V1\0";
const INDEX_HEADER_SIZE = 32; // magic(16) + record_count(8) + flags(8)
const RECORD_SIZE = 44; // packed_sfen(32) + moves_offset(8) + ply(2) + move_count(2)
const MOVE_ENTRY_SIZE_V0 = 4; // move16(2) + eval(2)
const MOVE_ENTRY_SIZE_V1 = 6; // move16(2) + eval(2) + depth(2)
// Number of index records prefetched per read and the approximate byte size
// flushed per batched write. YBB saves issue per-record I/O without batching,
// so large books spend most of their save time in syscalls.
const YBB_INDEX_READ_CHUNK_RECORDS = 4096;
const YBB_WRITE_FLUSH_BYTES = 256 * 1024;
// Window size for streaming the base moves area during merges. Base moves are
// consumed in base-record order, which matches the on-disk layout of
// ShogiHome-written files, so the window turns millions of small random reads
// into a handful of sequential bulk reads.
const YBB_MOVES_READ_WINDOW_BYTES = 16 * 1024 * 1024;
const MAX_SAFE_RECORD_COUNT = BigInt(
  Math.floor((Number.MAX_SAFE_INTEGER - INDEX_HEADER_SIZE) / RECORD_SIZE),
);

async function readExact(
  file: fs.promises.FileHandle,
  buf: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<void> {
  const { bytesRead } = await file.read(buf, offset, length, position);
  if (bytesRead !== length) {
    throw new Error(
      `YBB read error: expected ${length} bytes at offset ${position}, got ${bytesRead}`,
    );
  }
}

function moveEntrySize(flags: bigint): number {
  return (flags & 1n) === 1n ? MOVE_ENTRY_SIZE_V1 : MOVE_ENTRY_SIZE_V0;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`YBB: ${label} too large (${value})`);
  }
  return Number(value);
}

function validateRecordCount(recordCount: bigint): number {
  if (recordCount > MAX_SAFE_RECORD_COUNT) {
    throw new Error(`YBB: recordCount too large (${recordCount})`);
  }
  return Number(recordCount);
}

function validateYbbLayout(fileSize: number, recordCount: bigint): number {
  const recordCountNumber = validateRecordCount(recordCount);
  const movesAreaStart = INDEX_HEADER_SIZE + recordCountNumber * RECORD_SIZE;
  if (movesAreaStart > fileSize) {
    throw new Error(
      `YBB: index area exceeds file size: records=${recordCount} fileSize=${fileSize}`,
    );
  }
  return movesAreaStart;
}

function validateMovesRange(
  fileSize: number,
  movesAreaStart: number,
  movesRelOffset: bigint,
  moveCount: number,
  entrySize: number,
): number {
  const relOffset = safeNumber(movesRelOffset, "moves offset");
  const byteLength = moveCount * entrySize;
  const start = movesAreaStart + relOffset;
  const end = start + byteLength;
  if (start < movesAreaStart || end < start || end > fileSize) {
    throw new Error(
      `YBB: moves area exceeds file size: offset=${movesRelOffset} count=${moveCount} fileSize=${fileSize}`,
    );
  }
  return start;
}

function packedSfenFromBuffer(buf: Buffer | Uint8Array, offset: number): Uint32Array {
  const words = new Uint32Array(8);
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 32);
  for (let i = 0; i < 8; i++) {
    words[i] = view.getUint32(i * 4, true);
  }
  return words;
}

function comparePackedSfen(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

function packedSfenToBytes(words: Uint32Array): Uint8Array {
  return new Uint8Array(words.buffer, words.byteOffset, 32);
}

function readMoves(buf: Buffer, moveCount: number, entrySize: number): BookMove[] {
  const moves: BookMove[] = [];
  for (let i = 0; i < moveCount; i++) {
    const off = i * entrySize;
    const move16 = buf.readUInt16LE(off);
    const score = buf.readInt16LE(off + 2);
    const depth = entrySize >= MOVE_ENTRY_SIZE_V1 ? buf.readUInt16LE(off + 4) : undefined;
    const usi = fromYaneMove16(move16);
    const move: BookMove = { usi, score, comment: "" };
    if (depth !== undefined && depth > 0) {
      move.depth = depth;
    }
    moves.push(move);
  }
  return moves;
}

export async function loadYbbBook(path: string): Promise<YbbBook> {
  const data = await fs.promises.readFile(path);
  const magic = data.toString("ascii", 0, 16);
  if (magic !== MAGIC) {
    throw new Error(`Invalid YBB magic: ${magic}`);
  }
  const view = new DataView(data.buffer, data.byteOffset);
  const recordCount = view.getBigUint64(16, true);
  const flags = view.getBigUint64(24, true);
  const entrySize = moveEntrySize(flags);
  const recordCountNumber = validateRecordCount(recordCount);
  const movesAreaStart = validateYbbLayout(data.length, recordCount);
  const entries = new Map<string, BookEntry>();

  for (let i = 0; i < recordCountNumber; i++) {
    const recOff = INDEX_HEADER_SIZE + i * RECORD_SIZE;
    const packedSfen = packedSfenFromBuffer(data, recOff);
    const movesRelOffset = view.getBigUint64(recOff + 32, true);
    const ply = view.getUint16(recOff + 40, true);
    const moveCount = view.getUint16(recOff + 42, true);
    const sfen = packedSfenToSfen(packedSfen, 1);
    const movesAbsOffset = validateMovesRange(
      data.length,
      movesAreaStart,
      movesRelOffset,
      moveCount,
      entrySize,
    );
    const movesBuf = data.subarray(movesAbsOffset, movesAbsOffset + moveCount * entrySize);
    const moves = readMoves(movesBuf, moveCount, entrySize);
    entries.set(sfen, { type: "normal", comment: "", moves, minPly: ply });
  }

  return { format: "ybb", entries };
}

export type YbbOnTheFly = {
  format: "ybb";
  file: fs.promises.FileHandle;
  size: number;
  recordCount: bigint;
  flags: bigint;
  entries: Map<string, BookEntry>;
};

export async function openYbbBookOnTheFly(path: string): Promise<YbbOnTheFly> {
  const file = await fs.promises.open(path, "r");
  try {
    const stat = await file.stat();
    const headerBuf = Buffer.alloc(INDEX_HEADER_SIZE);
    await readExact(file, headerBuf, 0, INDEX_HEADER_SIZE, 0);
    const magic = headerBuf.toString("ascii", 0, 16);
    if (magic !== MAGIC) {
      throw new Error(`Invalid YBB magic: ${magic}`);
    }
    const view = new DataView(headerBuf.buffer, headerBuf.byteOffset);
    const recordCount = view.getBigUint64(16, true);
    const flags = view.getBigUint64(24, true);
    validateYbbLayout(stat.size, recordCount);
    return {
      format: "ybb",
      file,
      size: stat.size,
      recordCount,
      flags,
      entries: new Map<string, BookEntry>(),
    };
  } catch (e) {
    await file.close();
    throw e;
  }
}

export async function searchYbbBookMovesOnTheFly(
  sfen: string,
  file: fs.promises.FileHandle,
  size: number,
  recordCount: bigint,
  flags: bigint,
): Promise<BookEntry | undefined> {
  if (recordCount === 0n) {
    return undefined;
  }
  const target = sfenToPackedSfen(sfen);
  const targetBytes = packedSfenToBytes(target);
  const entrySize = moveEntrySize(flags);
  const movesAreaStart = validateYbbLayout(size, recordCount);
  const recBuf = Buffer.alloc(RECORD_SIZE);

  let lo = 0n;
  let hi = recordCount - 1n;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const offset = INDEX_HEADER_SIZE + Number(mid) * RECORD_SIZE;
    await readExact(file, recBuf, 0, RECORD_SIZE, offset);
    const cmp = comparePackedSfen(
      new Uint8Array(recBuf.buffer, recBuf.byteOffset, 32),
      targetBytes,
    );
    if (cmp === 0) {
      const view = new DataView(recBuf.buffer, recBuf.byteOffset);
      const movesRelOffset = view.getBigUint64(32, true);
      const moveCount = view.getUint16(42, true);
      const ply = view.getUint16(40, true);
      if (moveCount === 0) {
        return { type: "normal", comment: "", moves: [], minPly: ply };
      }
      const movesAbsOffset = validateMovesRange(
        size,
        movesAreaStart,
        movesRelOffset,
        moveCount,
        entrySize,
      );
      const movesBuf = Buffer.alloc(moveCount * entrySize);
      await readExact(file, movesBuf, 0, movesBuf.length, movesAbsOffset);
      const moves = readMoves(movesBuf, moveCount, entrySize);
      return { type: "normal", comment: "", moves, minPly: ply };
    } else if (cmp < 0) {
      lo = mid + 1n;
    } else {
      if (mid === 0n) {
        break;
      }
      hi = mid - 1n;
    }
  }
  return undefined;
}

type SortedEntry = {
  packedBytes: Uint8Array;
  sfen: string;
};

export async function storeYbbBook(
  entries: Map<string, BookEntry>,
  outputPath: string,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const sorted: SortedEntry[] = [];
  let hasDepth = false;

  for (const [sfen, entry] of entries) {
    if (entry.moves.length === 0) {
      continue;
    }
    const packed = sfenToPackedSfen(sfen);
    sorted.push({ packedBytes: packedSfenToBytes(packed), sfen });
    if (!hasDepth) {
      for (const m of entry.moves) {
        if (m.depth !== undefined && m.depth > 0) {
          hasDepth = true;
          break;
        }
      }
    }
  }

  onProgress?.(0.1);
  sorted.sort((a, b) => comparePackedSfen(a.packedBytes, b.packedBytes));

  const flags = hasDepth ? 1n : 0n;
  const entrySize = hasDepth ? MOVE_ENTRY_SIZE_V1 : MOVE_ENTRY_SIZE_V0;
  const recordCount = BigInt(sorted.length);
  const movesStart = INDEX_HEADER_SIZE + sorted.length * RECORD_SIZE;

  const output = await fs.promises.open(outputPath, "w");
  try {
    const headerBuf = Buffer.alloc(INDEX_HEADER_SIZE);
    headerBuf.write(MAGIC, 0, 16, "ascii");
    const headerView = new DataView(headerBuf.buffer, headerBuf.byteOffset);
    headerView.setBigUint64(16, recordCount, true);
    headerView.setBigUint64(24, flags, true);
    await output.write(headerBuf, 0, INDEX_HEADER_SIZE, 0);

    let indexPos = INDEX_HEADER_SIZE;
    let movesPos = movesStart;
    const total = sorted.length;

    // Both the index area and the moves area are written sequentially, so
    // records are accumulated and flushed in bulk instead of one write per
    // record. Output bytes are unchanged.
    const pendingIndex: Buffer[] = [];
    let pendingIndexBytes = 0;
    const pendingMoves: Buffer[] = [];
    let pendingMovesBytes = 0;
    async function flushIndex() {
      if (pendingIndex.length === 0) {
        return;
      }
      const data = Buffer.concat(pendingIndex, pendingIndexBytes);
      pendingIndex.length = 0;
      pendingIndexBytes = 0;
      await output.write(data, 0, data.length, indexPos);
      indexPos += data.length;
    }
    async function flushMoves() {
      if (pendingMoves.length === 0) {
        return;
      }
      const data = Buffer.concat(pendingMoves, pendingMovesBytes);
      pendingMoves.length = 0;
      pendingMovesBytes = 0;
      await output.write(data, 0, data.length, movesPos);
      movesPos += data.length;
    }

    for (let idx = 0; idx < total; idx++) {
      if (onProgress && idx % 10000 === 0) {
        onProgress(0.2 + (0.8 * idx) / total);
      }
      const item = sorted[idx];
      const entry = entries.get(item.sfen)!;
      const moveCount = entry.moves.length;

      const recBuf = Buffer.alloc(RECORD_SIZE);
      recBuf.set(item.packedBytes, 0);
      const recView = new DataView(recBuf.buffer, recBuf.byteOffset);
      recView.setBigUint64(32, BigInt(movesPos + pendingMovesBytes - movesStart), true);
      recView.setUint16(40, entry.minPly || 1, true);
      recView.setUint16(42, moveCount, true);
      pendingIndex.push(recBuf);
      pendingIndexBytes += RECORD_SIZE;
      if (pendingIndexBytes >= YBB_WRITE_FLUSH_BYTES) {
        await flushIndex();
      }

      const movesBuf = Buffer.alloc(moveCount * entrySize);
      for (let i = 0; i < moveCount; i++) {
        const m = entry.moves[i];
        const off = i * entrySize;
        movesBuf.writeUInt16LE(toYaneMove16(m.usi), off);
        movesBuf.writeInt16LE(m.score ?? 0, off + 2);
        if (hasDepth) {
          movesBuf.writeUInt16LE(m.depth ?? 0, off + 4);
        }
      }
      pendingMoves.push(movesBuf);
      pendingMovesBytes += movesBuf.length;
      if (pendingMovesBytes >= YBB_WRITE_FLUSH_BYTES) {
        await flushMoves();
      }
    }
    await flushIndex();
    await flushMoves();
  } finally {
    await output.close();
  }
}

type SortedPatch = {
  packedBytes: Uint8Array;
  sfen: string;
  entry: BookEntry;
};

export async function mergeYbbBook(
  baseFile: fs.promises.FileHandle,
  baseRecordCount: bigint,
  baseFlags: bigint,
  patches: Map<string, BookEntry>,
  outputPath: string,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const sortedPatches: SortedPatch[] = [];
  for (const [sfen, entry] of patches) {
    const packed = sfenToPackedSfen(sfen);
    sortedPatches.push({ packedBytes: packedSfenToBytes(packed), sfen, entry });
  }
  sortedPatches.sort((a, b) => comparePackedSfen(a.packedBytes, b.packedBytes));

  const baseSize = (await baseFile.stat()).size;
  const baseRecordCountNumber = validateRecordCount(baseRecordCount);
  const baseEntrySize = moveEntrySize(baseFlags);
  const baseMovesAreaStart = validateYbbLayout(baseSize, baseRecordCount);

  // Base index records are accessed strictly in order in both passes, so they
  // are prefetched in chunks instead of one read per record. The scratch
  // buffer is reused; callers must consume it before the next load.
  const recBuf = Buffer.alloc(RECORD_SIZE);
  let windowBuf = Buffer.allocUnsafe(0);
  let windowStart = 0;
  async function loadBaseRecord(idx: number): Promise<void> {
    if (idx < windowStart || idx >= windowStart + windowBuf.length / RECORD_SIZE) {
      const count = Math.min(YBB_INDEX_READ_CHUNK_RECORDS, baseRecordCountNumber - idx);
      windowBuf = Buffer.allocUnsafe(count * RECORD_SIZE);
      await readExact(
        baseFile,
        windowBuf,
        0,
        windowBuf.length,
        INDEX_HEADER_SIZE + idx * RECORD_SIZE,
      );
      windowStart = idx;
    }
    const off = (idx - windowStart) * RECORD_SIZE;
    windowBuf.copy(recBuf, 0, off, off + RECORD_SIZE);
  }

  // Streams the base moves area through a fixed-size window. Moves are
  // requested in base-record order, so for sequentially laid out files each
  // byte is read once. Files with non-sequential layouts still work via
  // window refill at a small cost. Returned views are valid only until the
  // next read call; callers that defer writes must copy.
  let movesWindow = Buffer.allocUnsafe(0);
  let movesWindowStart = 0;
  async function readBaseMoves(absOffset: number, length: number): Promise<Buffer> {
    if (length === 0) {
      return Buffer.allocUnsafe(0);
    }
    if (
      absOffset < movesWindowStart ||
      absOffset + length > movesWindowStart + movesWindow.length
    ) {
      const readSize = Math.max(
        Math.min(YBB_MOVES_READ_WINDOW_BYTES, baseSize - absOffset),
        length,
      );
      movesWindow = Buffer.allocUnsafe(readSize);
      await readExact(baseFile, movesWindow, 0, readSize, absOffset);
      movesWindowStart = absOffset;
    }
    const off = absOffset - movesWindowStart;
    return movesWindow.subarray(off, off + length);
  }

  let outputHasDepth = (baseFlags & 1n) === 1n;
  if (!outputHasDepth) {
    for (const p of sortedPatches) {
      if (p.entry.moves.some((m) => m.depth !== undefined && m.depth > 0)) {
        outputHasDepth = true;
        break;
      }
    }
  }

  // Pass 1: count output records
  const pass1Total = baseRecordCountNumber + sortedPatches.length;
  let outputRecordCount = 0n;
  let baseIdx = 0n;
  let patchIdx = 0;

  while (baseIdx < baseRecordCount || patchIdx < sortedPatches.length) {
    if (onProgress && Number(outputRecordCount) % 10000 === 0) {
      onProgress((0.1 * Number(outputRecordCount)) / pass1Total);
    }
    let cmp: number;
    if (baseIdx >= baseRecordCount) {
      cmp = 1;
    } else if (patchIdx >= sortedPatches.length) {
      cmp = -1;
    } else {
      await loadBaseRecord(Number(baseIdx));
      cmp = recBuf.compare(sortedPatches[patchIdx].packedBytes, 0, 32, 0, 32);
    }

    if (cmp < 0) {
      baseIdx++;
    } else if (cmp > 0) {
      patchIdx++;
    } else {
      baseIdx++;
      patchIdx++;
    }
    outputRecordCount++;
  }

  onProgress?.(0.1);

  const outputFlags = outputHasDepth ? 1n : 0n;
  const outputEntrySize = outputHasDepth ? MOVE_ENTRY_SIZE_V1 : MOVE_ENTRY_SIZE_V0;
  const outputRecordCountNumber = validateRecordCount(outputRecordCount);
  const movesStart = INDEX_HEADER_SIZE + outputRecordCountNumber * RECORD_SIZE;
  const outputTotal = outputRecordCountNumber;

  // Write header
  const output = await fs.promises.open(outputPath, "w");
  try {
    const headerBuf = Buffer.alloc(INDEX_HEADER_SIZE);
    headerBuf.write(MAGIC, 0, 16, "ascii");
    const headerView = new DataView(headerBuf.buffer, headerBuf.byteOffset);
    headerView.setBigUint64(16, outputRecordCount, true);
    headerView.setBigUint64(24, outputFlags, true);
    await output.write(headerBuf, 0, INDEX_HEADER_SIZE, 0);

    // Pass 2: interleaved index + moves write. Both output areas are
    // sequential, so records are accumulated and flushed in bulk instead of
    // one write per record. Output bytes are unchanged.
    let indexPos = INDEX_HEADER_SIZE;
    let movesPos = movesStart;
    baseIdx = 0n;
    patchIdx = 0;
    let outputWritten = 0;
    const pendingIndex: Buffer[] = [];
    let pendingIndexBytes = 0;
    const pendingMoves: Buffer[] = [];
    let pendingMovesBytes = 0;
    async function flushOutIndex() {
      if (pendingIndex.length === 0) {
        return;
      }
      const data = Buffer.concat(pendingIndex, pendingIndexBytes);
      pendingIndex.length = 0;
      pendingIndexBytes = 0;
      await output.write(data, 0, data.length, indexPos);
      indexPos += data.length;
    }
    async function flushOutMoves() {
      if (pendingMoves.length === 0) {
        return;
      }
      const data = Buffer.concat(pendingMoves, pendingMovesBytes);
      pendingMoves.length = 0;
      pendingMovesBytes = 0;
      await output.write(data, 0, data.length, movesPos);
      movesPos += data.length;
    }
    async function queueIndexRecord(record: Buffer) {
      pendingIndex.push(record);
      pendingIndexBytes += RECORD_SIZE;
      if (pendingIndexBytes >= YBB_WRITE_FLUSH_BYTES) {
        await flushOutIndex();
      }
    }
    async function queueMoves(data: Buffer) {
      pendingMoves.push(data);
      pendingMovesBytes += data.length;
      if (pendingMovesBytes >= YBB_WRITE_FLUSH_BYTES) {
        await flushOutMoves();
      }
    }
    function readBaseRecordFields(): { movesOffset: bigint; moveCount: number } {
      return {
        movesOffset: recBuf.readBigUInt64LE(32),
        moveCount: recBuf.readUInt16LE(42),
      };
    }

    while (baseIdx < baseRecordCount || patchIdx < sortedPatches.length) {
      if (onProgress && outputWritten % 10000 === 0) {
        onProgress(0.1 + (0.9 * outputWritten) / outputTotal);
      }
      let cmp: number;
      let baseMovesOffset = 0n;
      let baseMoveCount = 0;

      if (baseIdx >= baseRecordCount) {
        cmp = 1;
      } else if (patchIdx >= sortedPatches.length) {
        // Patches are exhausted but trailing base records remain. The scratch
        // record is not read on this path, so load it and extract its fields
        // (the original per-record code re-read it here as well).
        await loadBaseRecord(Number(baseIdx));
        ({ movesOffset: baseMovesOffset, moveCount: baseMoveCount } = readBaseRecordFields());
        cmp = -1;
      } else {
        await loadBaseRecord(Number(baseIdx));
        ({ movesOffset: baseMovesOffset, moveCount: baseMoveCount } = readBaseRecordFields());
        cmp = recBuf.compare(sortedPatches[patchIdx].packedBytes, 0, 32, 0, 32);
      }

      if (cmp < 0) {
        // base only — recBuf already contains the full record.
        // Overwrite only moves_offset in recBuf, then queue a copy as-is.
        recBuf.writeBigUInt64LE(BigInt(movesPos + pendingMovesBytes - movesStart), 32);
        await queueIndexRecord(Buffer.from(recBuf));

        const movesSize = baseMoveCount * baseEntrySize;
        const baseMovesAbsOffset = validateMovesRange(
          baseSize,
          baseMovesAreaStart,
          baseMovesOffset,
          baseMoveCount,
          baseEntrySize,
        );
        const baseMovesView = await readBaseMoves(baseMovesAbsOffset, movesSize);

        if (baseEntrySize === outputEntrySize) {
          // Copy: the view is invalidated by the next window refill while the
          // queued write is deferred until flush.
          await queueMoves(Buffer.from(baseMovesView));
        } else {
          // V0 records have no depth; zero-fill the extra V1 depth bytes.
          const outMoves = Buffer.alloc(baseMoveCount * outputEntrySize);
          for (let i = 0; i < baseMoveCount; i++) {
            baseMovesView.copy(
              outMoves,
              i * outputEntrySize,
              i * baseEntrySize,
              i * baseEntrySize + baseEntrySize,
            );
          }
          await queueMoves(outMoves);
        }
        baseIdx++;
      } else if (cmp > 0) {
        // patch only
        const patch = sortedPatches[patchIdx];
        const moves = patch.entry.moves;
        const outRec = Buffer.allocUnsafe(RECORD_SIZE);
        outRec.set(patch.packedBytes, 0);
        outRec.writeBigUInt64LE(BigInt(movesPos + pendingMovesBytes - movesStart), 32);
        outRec.writeUInt16LE(patch.entry.minPly || 1, 40);
        outRec.writeUInt16LE(moves.length, 42);
        await queueIndexRecord(outRec);

        const outMoves = Buffer.allocUnsafe(moves.length * outputEntrySize);
        for (let i = 0; i < moves.length; i++) {
          const off = i * outputEntrySize;
          outMoves.writeUInt16LE(toYaneMove16(moves[i].usi), off);
          outMoves.writeInt16LE(moves[i].score ?? 0, off + 2);
          if (outputHasDepth) {
            outMoves.writeUInt16LE(moves[i].depth ?? 0, off + 4);
          }
        }
        await queueMoves(outMoves);
        patchIdx++;
      } else {
        // both: merge
        const patch = sortedPatches[patchIdx];
        const baseMovesAbsOffset = validateMovesRange(
          baseSize,
          baseMovesAreaStart,
          baseMovesOffset,
          baseMoveCount,
          baseEntrySize,
        );
        // Consumed synchronously before the next window read, so no copy.
        const baseMovesView = await readBaseMoves(
          baseMovesAbsOffset,
          baseMoveCount * baseEntrySize,
        );
        const baseMoves = readMoves(baseMovesView, baseMoveCount, baseEntrySize);
        const baseEntry: BookEntry = {
          type: "normal",
          comment: "",
          moves: baseMoves,
          minPly: recBuf.readUInt16LE(40),
        };
        const merged = mergeBookEntries(baseEntry, patch.entry) || {
          type: "normal",
          comment: "",
          moves: [],
          minPly: baseEntry.minPly,
        };
        const moves = merged.moves;

        // reuse recBuf which has packed_sfen from the base record
        recBuf.writeBigUInt64LE(BigInt(movesPos + pendingMovesBytes - movesStart), 32);
        const basePly = recBuf.readUInt16LE(40);
        const patchPly = patch.entry.minPly;
        if (patchPly !== undefined && patchPly < basePly) {
          recBuf.writeUInt16LE(patchPly, 40);
        }
        recBuf.writeUInt16LE(moves.length, 42);
        await queueIndexRecord(Buffer.from(recBuf));

        const outMoves = Buffer.allocUnsafe(moves.length * outputEntrySize);
        for (let i = 0; i < moves.length; i++) {
          const off = i * outputEntrySize;
          outMoves.writeUInt16LE(toYaneMove16(moves[i].usi), off);
          outMoves.writeInt16LE(moves[i].score ?? 0, off + 2);
          if (outputHasDepth) {
            outMoves.writeUInt16LE(moves[i].depth ?? 0, off + 4);
          }
        }
        await queueMoves(outMoves);
        baseIdx++;
        patchIdx++;
      }
      outputWritten++;
    }
    await flushOutIndex();
    await flushOutMoves();
  } finally {
    await output.close();
  }
}
