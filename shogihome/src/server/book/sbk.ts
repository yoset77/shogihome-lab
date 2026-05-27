import fs from "node:fs";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { ImmutablePosition, Move, Position } from "tsshogi";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import {
  SBookMove as SBookMoveProto,
  SBookMoveEvaluation,
  SBookState,
  SBook,
} from "./proto/sbk.js";
import {
  BookEntry,
  BookMove,
  mergeBookEntries,
  SbkBook,
  SbkEval,
  SbkOnTheFlyLUT,
} from "./types.js";
import { fromSbkMove, toSbkMove } from "./sbk_move.js";
import { SbkMoveEvaluation } from "@/common/book.js";
import { packedSfenToSfen, positionToPackedSfen, sfenToPackedSfen } from "./packed_sfen.js";

const INITIAL_POSITION_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
const SBK_ON_THE_FLY_ROW_SIZE = 9;

function readVarint(data: Uint8Array, offset: number): [value: number, nextOffset: number] {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (offset >= data.length) {
      throw new Error("Invalid protobuf: unexpected EOF while reading varint");
    }
    const byte = data[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return [value, offset];
    }
    shift += 7;
  }
  throw new Error("Invalid protobuf: varint is too long");
}

function skipField(data: Uint8Array, offset: number, wireType: number): number {
  switch (wireType) {
    case 0: {
      const [, next] = readVarint(data, offset);
      return next;
    }
    case 1:
      if (offset + 8 > data.length) {
        throw new Error("Invalid protobuf: truncated 64-bit field");
      }
      return offset + 8;
    case 2: {
      const [length, next] = readVarint(data, offset);
      const end = next + length;
      if (end > data.length) {
        throw new Error("Invalid protobuf: truncated field payload");
      }
      return end;
    }
    case 5:
      if (offset + 4 > data.length) {
        throw new Error("Invalid protobuf: truncated 32-bit field");
      }
      return offset + 4;
    default:
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}

function scanSBookTopLevel(data: Uint8Array): {
  stateCount: number;
  sbkAuthor?: string;
  sbkDescription?: string;
} {
  let stateCount = 0;
  let sbkAuthor: string | undefined;
  let sbkDescription: string | undefined;
  let offset = 0;
  while (offset < data.length) {
    const [tag, next] = readVarint(data, offset);
    offset = next;
    if (tag === 0) {
      break;
    }
    const field = tag >>> 3;
    const wireType = tag & 0x7;

    if ((field === 1 || field === 2) && wireType === 2) {
      const [length, textOffset] = readVarint(data, offset);
      const end = textOffset + length;
      if (end > data.length) {
        throw new Error("Invalid protobuf: truncated field payload");
      }
      const text = Buffer.from(data.subarray(textOffset, end)).toString("utf-8");
      if (field === 1) {
        sbkAuthor = text;
      } else {
        sbkDescription = text;
      }
      offset = end;
      continue;
    }
    if (field === 3 && wireType === 2) {
      const [stateLength, stateOffset] = readVarint(data, offset);
      offset = stateOffset + stateLength;
      if (offset > data.length) {
        throw new Error("Invalid protobuf: truncated SBookState payload");
      }
      stateCount++;
      continue;
    }
    offset = skipField(data, offset, wireType);
  }
  return { stateCount, sbkAuthor, sbkDescription };
}

function readRowOffset(table: Uint32Array, row: number): number {
  return table[row * SBK_ON_THE_FLY_ROW_SIZE + 8];
}

function writeRowMetadata(table: Uint32Array, rowOffset: number, fileOffset: number): void {
  table[rowOffset + 8] = fileOffset >>> 0;
}

function compareRowPacked(table: Uint32Array, row: number, packedSfen: Uint32Array): number {
  const rowOffset = row * SBK_ON_THE_FLY_ROW_SIZE;
  for (let i = 0; i < 8; i++) {
    const a = table[rowOffset + i];
    const b = packedSfen[i];
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

function swapRows(table: Uint32Array, rowA: number, rowB: number, tempRow: Uint32Array): void {
  if (rowA === rowB) {
    return;
  }
  const offsetA = rowA * SBK_ON_THE_FLY_ROW_SIZE;
  const offsetB = rowB * SBK_ON_THE_FLY_ROW_SIZE;
  tempRow.set(table.subarray(offsetA, offsetA + SBK_ON_THE_FLY_ROW_SIZE));
  table.copyWithin(offsetA, offsetB, offsetB + SBK_ON_THE_FLY_ROW_SIZE);
  table.set(tempRow, offsetB);
}

function sortRows(
  table: Uint32Array,
  rowCount: number,
  compare: (row: number, pivot: Uint32Array) => number,
): void {
  if (rowCount <= 1) {
    return;
  }
  const ranges: number[] = [0, rowCount - 1];
  const pivot = new Uint32Array(SBK_ON_THE_FLY_ROW_SIZE);
  const tempRow = new Uint32Array(SBK_ON_THE_FLY_ROW_SIZE);

  while (ranges.length > 0) {
    const right = ranges.pop() as number;
    const left = ranges.pop() as number;
    if (left >= right) {
      continue;
    }
    const pivotIndex = left + Math.floor((right - left) / 2);
    const pivotOffset = pivotIndex * SBK_ON_THE_FLY_ROW_SIZE;
    pivot.set(table.subarray(pivotOffset, pivotOffset + SBK_ON_THE_FLY_ROW_SIZE));

    let i = left;
    let j = right;
    while (i <= j) {
      while (compare(i, pivot) < 0) {
        i++;
      }
      while (compare(j, pivot) > 0) {
        j--;
      }
      if (i <= j) {
        swapRows(table, i, j, tempRow);
        i++;
        j--;
      }
    }

    if (left < j && i < right) {
      if (j - left > right - i) {
        ranges.push(left, j, i, right);
      } else {
        ranges.push(i, right, left, j);
      }
    } else if (left < j) {
      ranges.push(left, j);
    } else if (i < right) {
      ranges.push(i, right);
    }
  }
}

function sortRowsByPackedSfen(table: Uint32Array, rowCount: number): void {
  sortRows(table, rowCount, (row, pivot) => compareRowPacked(table, row, pivot));
}

function sortRowsByOffset(table: Uint32Array, rowCount: number): void {
  sortRows(table, rowCount, (row, pivot) => {
    const offset = readRowOffset(table, row);
    const pivotOffset = readRowOffset(pivot, 0);
    if (offset === pivotOffset) {
      return 0;
    }
    return offset < pivotOffset ? -1 : 1;
  });
}

function isPackedZeroRow(table: Uint32Array, row: number): boolean {
  const rowOffset = row * SBK_ON_THE_FLY_ROW_SIZE;
  for (let i = 0; i < 8; i++) {
    if (table[rowOffset + i] !== 0) {
      return false;
    }
  }
  return true;
}

function isVisited(visitedBits: Uint8Array, stateIndex: number): boolean {
  return (visitedBits[stateIndex >> 3] & (1 << (stateIndex & 7))) !== 0;
}

function setVisited(visitedBits: Uint8Array, stateIndex: number): void {
  visitedBits[stateIndex >> 3] |= 1 << (stateIndex & 7);
}

function decodeStateAt(data: Uint8Array, stateTagOffset: number): SBookState {
  const [tag, afterTag] = readVarint(data, stateTagOffset);
  if (tag !== 26) {
    throw new Error(`Invalid SBookState tag: ${tag}`);
  }
  const [payloadLength, payloadOffset] = readVarint(data, afterTag);
  const end = payloadOffset + payloadLength;
  if (end > data.length) {
    throw new Error("Invalid SBK: truncated SBookState payload");
  }
  return SBookState.decode(data.subarray(payloadOffset, end));
}

function buildStateOffsetTable(data: Uint8Array, table: Uint32Array, rowCount: number): void {
  let offset = 0;
  let row = 0;
  while (offset < data.length) {
    const tagOffset = offset;
    const [tag, next] = readVarint(data, offset);
    offset = next;
    if (tag === 0) {
      break;
    }
    const field = tag >>> 3;
    const wireType = tag & 0x7;
    if (field === 3 && wireType === 2) {
      const [stateLength, payloadOffset] = readVarint(data, offset);
      if (row >= rowCount) {
        throw new Error("Invalid SBK: state count mismatch");
      }
      writeRowMetadata(table, row * SBK_ON_THE_FLY_ROW_SIZE, tagOffset);
      offset = payloadOffset + stateLength;
      if (offset > data.length) {
        throw new Error("Invalid SBK: truncated SBookState payload");
      }
      row++;
      continue;
    }
    offset = skipField(data, offset, wireType);
  }
  if (row !== rowCount) {
    throw new Error("Invalid SBK: failed to build state offset table");
  }
}

function setPackedSfenForRow(table: Uint32Array, row: number, position: ImmutablePosition): void {
  try {
    table.set(positionToPackedSfen(position), row * SBK_ON_THE_FLY_ROW_SIZE);
  } catch {
    // Some broken states cannot be indexed; they remain unreachable by search.
  }
}

function normalizeSfen(position: string): string | undefined {
  let s = position.trim();
  if (s.startsWith("position sfen ")) {
    s = s.slice("position sfen ".length);
  } else if (s.startsWith("sfen ")) {
    s = s.slice("sfen ".length);
  }
  // SFEN format: "board color hand moveCount" — normalize moveCount to 1
  const parts = s.split(" ");
  if (parts.length < 3) {
    return undefined;
  }
  return parts.slice(0, 3).join(" ") + " 1";
}

function toBookMoveEvaluation(value: SBookMoveEvaluation): SbkMoveEvaluation | undefined {
  switch (value) {
    case SBookMoveEvaluation.Forced:
    case SBookMoveEvaluation.Good:
    case SBookMoveEvaluation.Bad:
    case SBookMoveEvaluation.Blunder:
      return value;
    default:
      return undefined;
  }
}

function buildBookEntryFromState(state: SBookState, sfen: string): BookEntry | undefined {
  if (
    state.Moves.length === 0 &&
    state.Evals.length === 0 &&
    !state.Comment &&
    !state.Games &&
    !state.WonBlack &&
    !state.WonWhite
  ) {
    return;
  }
  const pos = Position.newBySFEN(sfen);
  if (!pos) {
    return;
  }
  const bookMoves: BookMove[] = state.Moves.flatMap((m) => {
    const move = fromSbkMove(pos, m.Move);
    if (!move) {
      return [];
    }
    return [
      {
        usi: move.usi,
        count: m.Weight || undefined,
        comment: "",
        evaluation: toBookMoveEvaluation(m.Evaluation),
        sbkId: m.NextStateId,
      },
    ];
  });

  const sbkEvals: SbkEval[] = state.Evals.map((e) => ({
    EvaluationValue: e.EvaluationValue,
    Depth: e.Depth,
    SelDepth: e.SelDepth,
    Nodes: e.Nodes,
    Variation: e.Variation || undefined,
    EngineName: e.EngineName || undefined,
  }));

  const bookEntry: BookEntry = {
    type: "normal",
    comment: state.Comment || "",
    moves: bookMoves,
    minPly: 0,
  };
  if (state.Games) {
    bookEntry.games = state.Games;
  }
  if (state.WonBlack) {
    bookEntry.wonBlack = state.WonBlack;
  }
  if (state.WonWhite) {
    bookEntry.wonWhite = state.WonWhite;
  }
  if (sbkEvals.length > 0) {
    bookEntry.sbkEvals = sbkEvals;
  }
  return bookEntry;
}

function fillPackedSfenByTraversal(data: Uint8Array, table: Uint32Array, stateCount: number): void {
  const visitedBits = new Uint8Array(Math.ceil(stateCount / 8));

  for (let rootIndex = 0; rootIndex < stateCount; rootIndex++) {
    if (isVisited(visitedBits, rootIndex)) {
      continue;
    }
    const rootState = decodeStateAt(data, readRowOffset(table, rootIndex));
    if (!rootState.Position) {
      if (rootIndex !== 0) {
        continue;
      }
      rootState.Position = INITIAL_POSITION_SFEN;
    }

    const rootSfen = normalizeSfen(rootState.Position);
    if (!rootSfen) {
      continue;
    }
    const pos = Position.newBySFEN(rootSfen);
    if (!pos) {
      continue;
    }

    const rootMoves = rootState.Moves.map((m) => fromSbkMove(pos, m.Move));
    const stack: {
      state: SBookState;
      moves: (Move | undefined)[];
      index: number;
      lastMove?: Move;
    }[] = [{ state: rootState, moves: rootMoves, index: 0 }];
    setPackedSfenForRow(table, rootIndex, pos);
    setVisited(visitedBits, rootIndex);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.moves.length) {
        stack.pop();
        if (frame.lastMove) {
          pos.undoMove(frame.lastMove);
        }
        continue;
      }
      const sbkMove = frame.state.Moves[frame.index];
      const move = frame.moves[frame.index];
      frame.index++;
      if (!move) {
        continue;
      }

      const nextStateIndex = sbkMove.NextStateId;
      if (
        nextStateIndex < 0 ||
        nextStateIndex >= stateCount ||
        isVisited(visitedBits, nextStateIndex)
      ) {
        continue;
      }
      if (!pos.doMove(move, { ignoreValidation: true })) {
        continue;
      }
      const nextState = decodeStateAt(data, readRowOffset(table, nextStateIndex));
      setPackedSfenForRow(table, nextStateIndex, pos);
      const nextMoves = nextState.Moves.map((m) => fromSbkMove(pos, m.Move));
      stack.push({ state: nextState, moves: nextMoves, index: 0, lastMove: move });
      setVisited(visitedBits, nextStateIndex);
    }
  }
}

function buildSbkOnTheFlyIndex(rawData: Uint8Array): SbkOnTheFlyLUT {
  const { stateCount } = scanSBookTopLevel(rawData);
  const table = new Uint32Array(stateCount * SBK_ON_THE_FLY_ROW_SIZE);
  const indexToOffset = new Uint32Array(stateCount);

  buildStateOffsetTable(rawData, table, stateCount);
  fillPackedSfenByTraversal(rawData, table, stateCount);
  for (let i = 0; i < stateCount; i++) {
    indexToOffset[i] = readRowOffset(table, i);
  }
  sortRowsByPackedSfen(table, stateCount);

  let firstNonZeroRow = 0;
  while (firstNonZeroRow < stateCount && isPackedZeroRow(table, firstNonZeroRow)) {
    firstNonZeroRow++;
  }
  return { table, rowCount: stateCount, firstNonZeroRow, indexToOffset };
}

function searchOnTheFlyRow(sfen: string, index: SbkOnTheFlyLUT): number | undefined {
  let packed: Uint32Array;
  try {
    packed = sfenToPackedSfen(sfen);
  } catch {
    return;
  }
  let left = index.firstNonZeroRow;
  let right = index.rowCount;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const cmp = compareRowPacked(index.table, mid, packed);
    if (cmp < 0) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  if (left < index.rowCount && compareRowPacked(index.table, left, packed) === 0) {
    return left;
  }
}

export async function loadSbkBookOnTheFly(path: string): Promise<SbkBook> {
  const rawData = await fs.promises.readFile(path);
  const { sbkAuthor, sbkDescription } = scanSBookTopLevel(rawData);
  return {
    format: "sbk",
    entries: new Map<string, BookEntry>(),
    sbkAuthor,
    sbkDescription,
    sbkIndex: buildSbkOnTheFlyIndex(rawData),
    rawData,
  };
}

export async function searchSbkBookEntryOnTheFly(
  sfen: string,
  data: Uint8Array,
  index: SbkOnTheFlyLUT,
): Promise<BookEntry | undefined> {
  const row = searchOnTheFlyRow(sfen, index);
  if (row === undefined) {
    return;
  }
  const state = decodeStateAt(data, readRowOffset(index.table, row));
  return buildBookEntryFromState(state, sfen);
}

function readSfenAtRow(table: Uint32Array, row: number): string {
  const rowOffset = row * SBK_ON_THE_FLY_ROW_SIZE;
  return packedSfenToSfen(table.subarray(rowOffset, rowOffset + 8));
}

function entryToSbkState(
  id: number,
  entry: BookEntry,
  sfen: string,
  usiToNextId: Map<string, number>,
  withPosition: boolean,
): SBookState {
  const pos = Position.newBySFEN(sfen);
  const sbkMoves: SBookMoveProto[] = [];
  if (pos) {
    for (const bookMove of entry.moves) {
      const move = pos.createMoveByUSI(bookMove.usi);
      if (!move) {
        continue;
      }
      sbkMoves.push({
        Move: toSbkMove(move),
        Evaluation: bookMove.evaluation || SBookMoveEvaluation.None,
        Weight: bookMove.count ?? 0,
        NextStateId: usiToNextId.get(bookMove.usi) ?? -1,
      });
    }
  }

  return {
    Id: id,
    BoardKey: 0n,
    HandKey: 0,
    Games: entry.games ?? 0,
    WonBlack: entry.wonBlack ?? 0,
    WonWhite: entry.wonWhite ?? 0,
    Position: withPosition ? sfen : undefined,
    Comment: entry.comment || undefined,
    Moves: sbkMoves,
    Evals: (entry.sbkEvals ?? []).map((e) => ({
      EvaluationValue: e.EvaluationValue,
      Depth: e.Depth,
      SelDepth: e.SelDepth,
      Nodes: e.Nodes,
      Variation: e.Variation ?? "",
      EngineName: e.EngineName ?? "",
    })),
  };
}

async function waitForDrain(output: Writable, getStreamError: () => Error | undefined) {
  const existingError = getStreamError();
  if (existingError) {
    throw existingError;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      output.off("drain", onDrain);
      output.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      const error = getStreamError();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    output.once("drain", onDrain);
    output.once("error", onError);
  });
}

async function storeSbkBookOnTheFly(
  book: Required<Pick<SbkBook, "rawData" | "sbkIndex">> & SbkBook,
  output: Writable,
): Promise<void> {
  let streamError: Error | undefined;
  output.on("error", (error: Error) => {
    streamError = error;
  });
  async function writeBytes(bytes: Uint8Array): Promise<void> {
    if (streamError) {
      throw streamError;
    }
    if (!output.write(bytes)) {
      await waitForDrain(output, () => streamError);
    }
    if (streamError) {
      throw streamError;
    }
  }

  try {
    const inMemoryRef = new Set<string>();
    const newSfens = new Set<string>();
    const rootSfens = new Set<string>();

    for (const [sfen, entry] of book.entries) {
      const pos = Position.newBySFEN(sfen);
      if (!pos) {
        continue;
      }

      for (const bookMove of entry.moves) {
        const move = pos.createMoveByUSI(bookMove.usi);
        if (!move || !pos.doMove(move, { ignoreValidation: true })) {
          continue;
        }
        inMemoryRef.add(pos.sfen);
        pos.undoMove(move);
      }

      const sbkEntry = await searchSbkBookEntryOnTheFly(sfen, book.rawData, book.sbkIndex);
      if (!sbkEntry) {
        newSfens.add(sfen);
        continue;
      }

      const removedMoves = sbkEntry.moves.filter(
        (move) => !entry.moves.some((bookMove) => bookMove.usi === move.usi),
      );
      for (const bookMove of removedMoves) {
        const move = pos.createMoveByUSI(bookMove.usi);
        if (!move || !pos.doMove(move, { ignoreValidation: true })) {
          continue;
        }
        rootSfens.add(pos.sfen);
        pos.undoMove(move);
      }
    }

    for (const sfen of inMemoryRef) {
      if (!newSfens.has(sfen) && searchOnTheFlyRow(sfen, book.sbkIndex) === undefined) {
        newSfens.add(sfen);
      }
    }
    for (const [sfen] of book.entries) {
      if (!inMemoryRef.has(sfen) && newSfens.has(sfen)) {
        rootSfens.add(sfen);
      }
    }

    const newSfenToId = new Map<string, number>();
    let nextId = book.sbkIndex.rowCount;
    for (const sfen of newSfens) {
      newSfenToId.set(sfen, nextId++);
    }

    const sfenAndUsiToNextId = new Map<string, Map<string, number>>();
    for (const [sfen, entry] of book.entries) {
      const usiToNextId = new Map<string, number>();
      const sbkEntry = await searchSbkBookEntryOnTheFly(sfen, book.rawData, book.sbkIndex);
      if (sbkEntry) {
        for (const bookMove of sbkEntry.moves) {
          if (bookMove.sbkId !== undefined && bookMove.sbkId >= 0) {
            usiToNextId.set(bookMove.usi, bookMove.sbkId);
          }
        }
      }
      const pos = Position.newBySFEN(sfen);
      if (pos) {
        for (const bookMove of entry.moves) {
          if (usiToNextId.has(bookMove.usi)) {
            continue;
          }
          const move = pos.createMoveByUSI(bookMove.usi);
          if (!move || !pos.doMove(move, { ignoreValidation: true })) {
            continue;
          }
          const nextSfen = pos.sfen;
          let resolvedNextId = newSfenToId.get(nextSfen);
          if (resolvedNextId === undefined) {
            const row = searchOnTheFlyRow(nextSfen, book.sbkIndex);
            if (row !== undefined) {
              resolvedNextId = decodeStateAt(
                book.rawData,
                readRowOffset(book.sbkIndex.table, row),
              ).Id;
            }
          }
          if (resolvedNextId !== undefined) {
            usiToNextId.set(bookMove.usi, resolvedNextId);
          }
          pos.undoMove(move);
        }
      }
      sfenAndUsiToNextId.set(sfen, usiToNextId);
    }

    sortRowsByOffset(book.sbkIndex.table, book.sbkIndex.rowCount);

    await writeBytes(
      SBook.encode({
        Author: book.sbkAuthor ?? "",
        Description: book.sbkDescription ?? "",
        BookStates: [],
      }).finish(),
    );

    for (let id = 0; id < book.sbkIndex.rowCount; id++) {
      const sfen = readSfenAtRow(book.sbkIndex.table, id);
      const patch = book.entries.get(sfen);
      let state: SBookState | undefined;

      if (!patch) {
        state = decodeStateAt(book.rawData, readRowOffset(book.sbkIndex.table, id));
        state.BoardKey = 0n;
        state.HandKey = 0;
      } else if (patch.type === "normal") {
        const usiToNextId = sfenAndUsiToNextId.get(sfen) ?? new Map<string, number>();
        state = entryToSbkState(id, patch, sfen, usiToNextId, rootSfens.has(sfen));
      } else {
        const offset = readRowOffset(book.sbkIndex.table, id);
        state = decodeStateAt(book.rawData, offset);
        const baseEntry = buildBookEntryFromState(state, sfen);
        const entry = mergeBookEntries(baseEntry, patch);
        if (entry) {
          const usiToNextId = sfenAndUsiToNextId.get(sfen) ?? new Map<string, number>();
          state = entryToSbkState(
            id,
            entry,
            sfen,
            usiToNextId,
            !!state.Position || rootSfens.has(sfen),
          );
        }
      }
      if (!state) {
        continue;
      }
      const stateWriter = new BinaryWriter();
      SBookState.encode(state, stateWriter.uint32(26).fork()).join();
      await writeBytes(stateWriter.finish());
    }

    for (const sfen of newSfens) {
      const id = newSfenToId.get(sfen);
      if (id === undefined) {
        continue;
      }
      const entry = book.entries.get(sfen) ?? {
        type: "normal" as const,
        comment: "",
        moves: [],
        minPly: 0,
      };
      const usiToNextId = sfenAndUsiToNextId.get(sfen) ?? new Map<string, number>();
      const state = entryToSbkState(id, entry, sfen, usiToNextId, rootSfens.has(sfen));
      const stateWriter = new BinaryWriter();
      SBookState.encode(state, stateWriter.uint32(26).fork()).join();
      await writeBytes(stateWriter.finish());
    }

    output.end();
    await finished(output);
  } finally {
    sortRowsByPackedSfen(book.sbkIndex.table, book.sbkIndex.rowCount);
  }
}

export function loadSbkBook(data: Buffer | Uint8Array): SbkBook {
  const book = SBook.decode(data);
  if (book.BookStates.length > 0 && !book.BookStates[0].Position) {
    book.BookStates[0].Position = INITIAL_POSITION_SFEN;
  }

  const entries = new Map<string, BookEntry>();
  function addEntry(sfen: string, state: SBookState, moves: (Move | undefined)[]) {
    // Skip leaf states that only contain default proto values.
    if (
      state.Moves.length === 0 &&
      state.Evals.length === 0 &&
      !state.Comment &&
      !state.Games &&
      !state.WonBlack &&
      !state.WonWhite
    ) {
      return;
    }

    const bookMoves: BookMove[] = state.Moves.flatMap((m, index) => {
      const move = moves[index];
      if (!move) {
        return [];
      }
      return [
        {
          usi: move.usi,
          count: m.Weight || undefined,
          comment: "",
          evaluation: toBookMoveEvaluation(m.Evaluation),
          sbkId: m.NextStateId,
        },
      ];
    });

    const sbkEvals: SbkEval[] = state.Evals.map((e) => ({
      EvaluationValue: e.EvaluationValue,
      Depth: e.Depth,
      SelDepth: e.SelDepth,
      Nodes: e.Nodes,
      Variation: e.Variation || undefined,
      EngineName: e.EngineName || undefined,
    }));

    const bookEntry: BookEntry = {
      type: "normal",
      comment: "",
      moves: bookMoves,
      minPly: 0,
    };
    if (state.Comment) {
      bookEntry.comment = state.Comment;
    }
    if (state.Games) {
      bookEntry.games = state.Games;
    }
    if (state.WonBlack) {
      bookEntry.wonBlack = state.WonBlack;
    }
    if (state.WonWhite) {
      bookEntry.wonWhite = state.WonWhite;
    }
    if (sbkEvals.length > 0) {
      bookEntry.sbkEvals = sbkEvals;
    }
    entries.set(sfen, bookEntry);
  }

  const visitedStateIds = new Set<number>();
  for (const rootState of book.BookStates) {
    if (!rootState.Position || visitedStateIds.has(rootState.Id)) {
      continue;
    }
    const rootSfen = normalizeSfen(rootState.Position);
    if (!rootSfen) {
      continue;
    }
    const pos = Position.newBySFEN(rootSfen);
    if (!pos) {
      continue;
    }
    const stack: {
      state: SBookState;
      moves: (Move | undefined)[];
      index: number;
      lastMove?: Move;
    }[] = [];
    const moves = rootState.Moves.map((m) => fromSbkMove(pos, m.Move));
    stack.push({ state: rootState, moves, index: 0 });
    addEntry(rootSfen, rootState, moves);
    visitedStateIds.add(rootState.Id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.moves.length) {
        stack.pop();
        if (frame.lastMove) {
          pos.undoMove(frame.lastMove);
        }
        continue;
      }
      const sbkMove = frame.state.Moves[frame.index];
      const move = frame.moves[frame.index];
      frame.index++;
      if (!move) {
        continue;
      }
      const nextStateId = sbkMove.NextStateId;
      if (visitedStateIds.has(nextStateId)) {
        continue;
      }
      if (!pos.doMove(move, { ignoreValidation: true })) {
        continue;
      }
      const nextState = book.BookStates[nextStateId];
      if (!nextState) {
        pos.undoMove(move);
        continue;
      }
      const nextSfen = pos.sfen;
      const nextMoves = nextState.Moves.map((m) => fromSbkMove(pos, m.Move));
      stack.push({ state: nextState, moves: nextMoves, index: 0, lastMove: move });
      addEntry(nextSfen, nextState, nextMoves);
      visitedStateIds.add(nextStateId);
    }
  }

  return { format: "sbk", entries, sbkAuthor: book.Author, sbkDescription: book.Description };
}

export async function storeSbkBook(book: SbkBook, output: Writable): Promise<void> {
  if (book.sbkIndex && book.rawData) {
    await storeSbkBookOnTheFly({ ...book, sbkIndex: book.sbkIndex, rawData: book.rawData }, output);
    return;
  }

  // SFEN の記述を最小限にしてデータを削減するためにルートではないノードを列挙する。
  const nonRootSfens = new Set<string>();

  // 局面と指し手のデコードの負荷が高いため、DFS の過程で局面と指し手を列挙しておく。
  const sfenToEdges = new Map<string, [BookMove, number, string][]>();

  for (const [rootSfen, rootEntry] of book.entries) {
    // DFS で訪問したことがある局面はそれ以上調べる必要がない。
    // ここで訪問済みでないノードはルートノードになる可能性があるが、
    // 他のノードからの探索がおわるまではルートノードかどうかが確定しない。
    if (sfenToEdges.has(rootSfen)) {
      continue; // 訪問済み
    }
    // newBySFEN は負荷が高いため、DFS の開始点だけで呼び出して残りは差分計算をする。
    const pos = Position.newBySFEN(rootSfen);
    if (!pos) {
      continue;
    }
    // ルートノードを特定するためにエッジを経由して到達可能な子ノードを DFS で列挙する。
    const stack: { sfen: string; bookMoves: BookMove[]; index: number; lastMove?: Move }[] = [
      { sfen: rootSfen, bookMoves: rootEntry.moves, index: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.bookMoves.length) {
        stack.pop();
        if (frame.lastMove) {
          pos.undoMove(frame.lastMove);
        }
        continue;
      }
      const bookMove = frame.bookMoves[frame.index];
      frame.index++;
      const move = pos.createMoveByUSI(bookMove.usi);
      if (!move || !pos.doMove(move, { ignoreValidation: true })) {
        continue;
      }
      let edges = sfenToEdges.get(frame.sfen);
      if (!edges) {
        edges = [];
        sfenToEdges.set(frame.sfen, edges);
      }
      const nextSfen = pos.sfen;
      edges.push([bookMove, toSbkMove(move), nextSfen]);
      const nextEntry = book.entries.get(nextSfen);
      if (!nextEntry) {
        pos.undoMove(move);
        continue; // エントリーに含まれないリーフノード
      }
      if (nextSfen !== rootSfen) {
        // SFEN を省略してよいノード
        nonRootSfens.add(nextSfen);
      }
      if (sfenToEdges.has(nextSfen)) {
        pos.undoMove(move);
        continue; // 訪問済み
      }
      stack.push({ sfen: nextSfen, bookMoves: nextEntry.moves, index: 0, lastMove: move });
    }
  }

  // ノードに ID を割り当てる。
  // ID は書き出す時の順序と一致しなければならない。
  // ルートノードを先頭に書かないと ShogiGUI で正しく読み込まれない。
  let newId = 0;
  const sfenToId = new Map<string, number>();
  for (const [sfen] of book.entries) {
    if (!nonRootSfens.has(sfen)) {
      sfenToId.set(sfen, newId++);
    }
  }
  for (const [sfen] of book.entries) {
    if (nonRootSfens.has(sfen)) {
      sfenToId.set(sfen, newId++);
    }
  }

  // データ全体を一気に encode するとメモリを大量に消費してしまうため、チャンク単位で書き出す。
  const CHUNK_SIZE = 64 * 1024;
  const pendingChunks: Uint8Array[] = [];
  let pendingSize = 0;
  let streamError: Error | undefined;
  output.on("error", (error: Error) => {
    streamError = error;
  });

  async function waitForDrain() {
    if (streamError) {
      throw streamError;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        output.off("drain", onDrain);
        output.off("error", onError);
      };
      const onDrain = () => {
        cleanup();
        if (streamError) {
          reject(streamError);
        } else {
          resolve();
        }
      };
      const onError = (error: Error) => {
        streamError = error;
        cleanup();
        reject(error);
      };
      output.once("drain", onDrain);
      output.once("error", onError);
    });
  }

  async function flush() {
    if (streamError) {
      throw streamError;
    }
    if (pendingChunks.length === 0) {
      return;
    }
    const combined = Buffer.concat(pendingChunks);
    pendingChunks.length = 0;
    pendingSize = 0;
    if (!output.write(combined)) {
      await waitForDrain();
    }
    if (streamError) {
      throw streamError;
    }
  }

  async function writeBytes(bytes: Uint8Array) {
    pendingChunks.push(bytes);
    pendingSize += bytes.length;
    if (pendingSize >= CHUNK_SIZE) {
      await flush();
    }
  }

  await writeBytes(
    SBook.encode({
      Author: book.sbkAuthor ?? "",
      Description: book.sbkDescription ?? "",
      BookStates: [],
    }).finish(),
  );

  async function writeState(sfen: string, entry: BookEntry): Promise<void> {
    const id = sfenToId.get(sfen);
    if (id === undefined) {
      return;
    }
    const edges = sfenToEdges.get(sfen) ?? [];
    const sbkMoves: SBookMoveProto[] = edges.map(([bookMove, move, nextSfen]) => ({
      Move: move,
      Evaluation: bookMove.evaluation || SBookMoveEvaluation.None,
      Weight: bookMove.count ?? 0,
      NextStateId: sfenToId.get(nextSfen) ?? -1, // 存在しない局面に対して BookConv は -1 を出力している
    }));

    const state: SBookState = {
      Id: id,
      // ShogiGUI のハッシュ関数が非公開のため BoardKey と HandKey は省略
      // 定義上は required だが BookConv が 0 を出力しているので問題ないと思われる
      BoardKey: 0n,
      HandKey: 0,
      Games: entry.games ?? 0,
      WonBlack: entry.wonBlack ?? 0,
      WonWhite: entry.wonWhite ?? 0,
      // 他のエントリーから参照されているノードの Position は省略
      Position: nonRootSfens.has(sfen) ? undefined : sfen,
      Comment: entry.comment || undefined,
      Moves: sbkMoves,
      Evals: (entry.sbkEvals ?? []).map((e) => ({
        EvaluationValue: e.EvaluationValue,
        Depth: e.Depth,
        SelDepth: e.SelDepth,
        Nodes: e.Nodes,
        Variation: e.Variation ?? "",
        EngineName: e.EngineName ?? "",
      })),
    };

    const stateWriter = new BinaryWriter();
    SBookState.encode(state, stateWriter.uint32(26).fork()).join();
    await writeBytes(stateWriter.finish());
  }

  for (const [sfen, entry] of book.entries) {
    if (!nonRootSfens.has(sfen)) {
      await writeState(sfen, entry);
    }
  }
  for (const [sfen, entry] of book.entries) {
    if (nonRootSfens.has(sfen)) {
      await writeState(sfen, entry);
    }
  }

  await flush();
  output.end();
  await finished(output);
}
