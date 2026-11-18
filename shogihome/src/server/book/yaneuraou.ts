import fs from "node:fs";
import readline from "node:readline";
import events from "node:events";
import { Readable, Writable } from "node:stream";
import { YaneBook, BookEntry, BookMove, mergeBookEntries } from "./types.js";
import { getAppLogger } from "@/node/log";

const YANEURAOU_BOOK_HEADER_V100 = "#YANEURAOU-DB2016 1.00";

const MOVE_NONE = "none";
const SCORE_NONE = "none";
const DEPTH_NONE = "none";

const SFENMarker = "sfen ";
const CommentMarker1 = "#";
const CommentMarker2 = "//";
const LF = "\n".charCodeAt(0);
const CR = "\r".charCodeAt(0);
const SEARCH_PROBE_BYTES = 4 * 1024;
const SEARCH_ENTRY_BYTES = 8 * 1024;

type Line = CommentLine | PositionLine | MoveLine;

type CommentLine = {
  type: "comment";
  comment: string;
};

type PositionLine = {
  type: "position";
  sfen: string;
  ply: number;
};

type MoveLine = {
  type: "move";
  move: BookMove;
};

function normalizeSFEN(sfen: string): [string, number] {
  // 手数部分は省略される場合があるので、手数部分を除いた範囲を抽出する。
  const begin = 5;
  let end = begin;
  for (let columns = 0; end < sfen.length; end++) {
    if (sfen[end] !== " ") {
      continue;
    }
    columns++;
    if (columns === 3) {
      break;
    }
  }
  return [
    // 手数部分を 1 にした SFEN
    sfen.slice(begin, end) + " 1",
    // オリジナルの手数
    parseInt(sfen.slice(end + 1), 10) || 0,
  ];
}

function parseOptionalInteger(column: string | undefined): number | undefined {
  const value = parseInt(column ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseLine(line: string): Line {
  // コメント
  if (line.startsWith(CommentMarker1)) {
    return { type: "comment", comment: line.slice(CommentMarker1.length) };
  } else if (line.startsWith(CommentMarker2)) {
    return { type: "comment", comment: line.slice(CommentMarker2.length) };
  }

  // 局面
  if (line.startsWith(SFENMarker)) {
    const [sfen, ply] = normalizeSFEN(line);
    return { type: "position", sfen, ply };
  }

  // 定跡手
  if (/^[1-9][a-i][1-9][a-i]\+? /.test(line) || /^[RBGSNLP]\*[1-9][a-i] /.test(line)) {
    const columns = line.split(" ", 5);
    let commentIndex = 0;
    for (let i = 0; i < columns.length; i++) {
      commentIndex += columns[i].length + 1;
    }
    return {
      type: "move",
      move: {
        usi: columns[0],
        usi2: columns[1] === MOVE_NONE ? undefined : columns[1],
        score: parseOptionalInteger(columns[2]),
        depth: parseOptionalInteger(columns[3]),
        count: parseOptionalInteger(columns[4]),
        comment:
          commentIndex < line.length ? line.slice(commentIndex).replace(/^(#|\/\/)/, "") : "",
      },
    };
  }

  // どれにも該当しない行はコメントとみなす。
  return { type: "comment", comment: line.slice(0) };
}

function appendCommentLine(base: string, next: string): string {
  return base ? base + "\n" + next : next;
}

async function load(input: Readable, nextEntry: (sfen: string, entry: BookEntry) => Promise<void>) {
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    let current: [sfen: string, entry: BookEntry] | undefined;
    let lineNo = 0;
    for await (let line of reader) {
      if (lineNo === 0) {
        line = line.replace(/^\uFEFF/, "");
      }
      const parsed = parseLine(line);
      switch (parsed.type) {
        case "comment":
          if (lineNo === 0 && line !== YANEURAOU_BOOK_HEADER_V100) {
            throw new Error("Unsupported book header: " + line);
          }
          if (current) {
            if (current[1].moves.length === 0) {
              const bookEntry = current[1];
              bookEntry.comment = appendCommentLine(bookEntry.comment, parsed.comment);
            } else {
              const moves = current[1].moves;
              const move = moves[moves.length - 1];
              move.comment = appendCommentLine(move.comment, parsed.comment);
            }
          }
          break;
        case "position":
          if (current) {
            await nextEntry(current[0], current[1]);
          }
          current = [parsed.sfen, { type: "normal", comment: "", moves: [], minPly: parsed.ply }];
          break;
        case "move":
          if (current) {
            current[1].moves.push(parsed.move);
          } else {
            getAppLogger().warn("Move line without position line: line=%d", lineNo);
          }
          break;
      }
      lineNo++;
    }
    if (current) {
      await nextEntry(current[0], current[1]);
    }
  } finally {
    reader.close();
  }
}

export async function loadYaneuraOuBook(input: Readable): Promise<YaneBook> {
  const entries: Map<string, BookEntry> = new Map();
  await load(input, async (sfen, entry) => {
    const existing = entries.get(sfen);
    if (!existing || entry.minPly < existing.minPly) {
      entries.set(sfen, entry);
    }
  });
  return { format: "yane2016", entries };
}

function buildEntryText(sfen: string, entry: BookEntry): string {
  if (entry.moves.length === 0) {
    return "";
  }
  if (
    /[\r\n]/.test(sfen) ||
    entry.moves.some(
      (move) => /[\r\n]/.test(move.usi) || (move.usi2 !== undefined && /[\r\n]/.test(move.usi2)),
    )
  ) {
    throw new Error("Invalid book position or move");
  }
  const commentLines = (comment: string) => comment.replace(/\r\n?|\n/g, "\n").split("\n");
  let buffer = SFENMarker + sfen + "\n";
  if (entry.comment) {
    for (const commentLine of commentLines(entry.comment)) {
      buffer += CommentMarker1 + commentLine + "\n";
    }
  }
  for (const move of entry.moves) {
    buffer +=
      move.usi +
      " " +
      (move.usi2 || MOVE_NONE) +
      " " +
      (move.score != undefined ? move.score.toFixed(0) : SCORE_NONE) +
      " " +
      (move.depth != undefined ? move.depth.toFixed(0) : DEPTH_NONE) +
      " " +
      (move.count != undefined ? move.count.toFixed(0) : "") +
      "\n";
    if (move.comment) {
      for (const commentLine of commentLines(move.comment)) {
        buffer += CommentMarker1 + commentLine + "\n";
      }
    }
  }
  return buffer;
}

// Batches per-position text into fewer output.write calls. Saving a large book
// issues one write per position without batching, so the per-call overhead
// dominates once the file has millions of positions.
class EntryBatchWriter {
  private chunks: string[] = [];
  private bufferedLength = 0;

  constructor(
    private output: Writable,
    private flushThreshold = 256 * 1024,
  ) {}

  async write(text: string): Promise<void> {
    if (!text) {
      return;
    }
    this.chunks.push(text);
    this.bufferedLength += text.length;
    if (this.bufferedLength >= this.flushThreshold) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.chunks.length === 0) {
      return;
    }
    const data = this.chunks.join("");
    this.chunks = [];
    this.bufferedLength = 0;
    if (!this.output.write(data)) {
      await events.once(this.output, "drain");
    }
  }
}

export async function storeYaneuraOuBook(book: YaneBook, output: Writable): Promise<void> {
  if (book.format !== "yane2016") {
    return Promise.reject(new Error(`Expected book format "yane2016" but got "${book.format}"`));
  }
  const end = new Promise((resolve, reject) => {
    output.on("finish", resolve);
    output.on("error", reject);
  });
  output.write(YANEURAOU_BOOK_HEADER_V100 + "\n");
  const writer = new EntryBatchWriter(output);
  for (const sfen of Array.from(book.entries.keys()).sort()) {
    const entry = book.entries.get(sfen) as BookEntry;
    await writer.write(buildEntryText(sfen, entry));
  }
  await writer.flush();
  output.end();
  await end;
}

export async function mergeYaneuraOuBook(
  input: Readable,
  bookPatch: YaneBook,
  output: Writable,
): Promise<void> {
  if (bookPatch.format !== "yane2016") {
    return Promise.reject(
      new Error(`Expected book format "yane2016" but got "${bookPatch.format}"`),
    );
  }
  const end = new Promise((resolve, reject) => {
    output.on("finish", resolve);
    output.on("error", reject);
  });
  output.write(YANEURAOU_BOOK_HEADER_V100 + "\n");
  const patchKeys = Array.from(bookPatch.entries.keys()).sort();
  let patchIndex = 0;
  let lastPatchKey = "";
  const writer = new EntryBatchWriter(output);
  try {
    await load(input, async (sfen, entry) => {
      for (; patchIndex < patchKeys.length; patchIndex++) {
        const patchKey = patchKeys[patchIndex];
        if (patchKey > sfen) {
          break;
        }
        let patch = bookPatch.entries.get(patchKey) as BookEntry;
        if (patchKey === sfen) {
          patch = mergeBookEntries(entry, patch) as BookEntry;
        }
        await writer.write(buildEntryText(patchKey, patch));
        lastPatchKey = patchKey;
      }
      if (sfen !== lastPatchKey) {
        await writer.write(buildEntryText(sfen, entry));
      }
    });
    for (; patchIndex < patchKeys.length; patchIndex++) {
      const patchKey = patchKeys[patchIndex];
      await writer.write(buildEntryText(patchKey, bookPatch.entries.get(patchKey) as BookEntry));
    }
    await writer.flush();
    output.end();
  } catch (error) {
    output.destroy(new Error(`Failed to merge YaneuraOu book: ${error}`));
  }
  await end;
}

export async function validateBookPositionOrdering(input: Readable): Promise<boolean> {
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    let prev: string | undefined;
    let count = 0;
    for await (const line of reader) {
      if (!line.startsWith(SFENMarker)) {
        continue;
      }
      if (prev && prev >= line) {
        return false;
      }
      count++;
      if (count >= 10000) {
        break;
      }
      prev = line;
    }
    return true;
  } finally {
    reader.close();
  }
}

function checkSFENMarker(offset: number, buffer: Buffer): boolean {
  for (let i = 0; i < SFENMarker.length; i++) {
    if (buffer[offset + i] !== SFENMarker.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function findLineEnd(buffer: Buffer, size: number, offset: number): number {
  let end = offset;
  while (end < size && buffer[end] !== LF && buffer[end] !== CR) {
    end++;
  }
  return end;
}

function findSFENMarker(buffer: Buffer, size: number, start: number, isFileHead: boolean): number {
  if (isFileHead && size >= SFENMarker.length) {
    // A headerless file may start with a position, optionally preceded by a BOM.
    if (start === 0 && checkSFENMarker(0, buffer)) {
      return 0;
    } else if (
      start <= 3 &&
      size >= 3 + SFENMarker.length &&
      buffer[0] === 0xef &&
      buffer[1] === 0xbb &&
      buffer[2] === 0xbf &&
      checkSFENMarker(3, buffer)
    ) {
      return 3;
    }
  }
  for (let i = Math.max(1, start); i <= size - SFENMarker.length; i++) {
    if ((buffer[i - 1] === LF || buffer[i - 1] === CR) && checkSFENMarker(i, buffer)) {
      return i;
    }
  }
  return -1;
}

async function binarySearch(
  sfen: string,
  file: fs.promises.FileHandle,
  size: number,
  buffer: Buffer,
): Promise<[number, number]> {
  let begin = 0;
  let end = size;
  let readOffset = -1;
  let bytesRead = 0;
  while (begin < end) {
    const mid = begin + Math.floor((end - begin) / 2);

    let head = mid;
    let marker = -1;
    while (head < end) {
      // Include the preceding delimiter, or the BOM near the start of the file.
      const probeStart = head <= 3 ? 0 : head - 1;
      if (probeStart < readOffset || head + SFENMarker.length > readOffset + bytesRead) {
        ({ bytesRead } = await file.read(buffer, 0, SEARCH_PROBE_BYTES, probeStart));
        readOffset = probeStart;
      }
      marker = findSFENMarker(buffer, bytesRead, head - readOffset, readOffset === 0);
      if (marker >= 0) break;
      // Overlap the delimiter and marker when either straddles a read boundary.
      const nextHead = readOffset + bytesRead - SFENMarker.length + 1;
      if (nextHead <= head || readOffset + bytesRead >= size) break;
      head = nextHead;
    }
    const sfenOffset = readOffset + marker;
    if (marker < 0 || sfenOffset >= end) {
      // No position in the right half. The target may be before a long entry.
      end = mid;
      continue;
    }

    // Decode from the probe itself unless the SFEN line crosses its boundary.
    let lineEnd = findLineEnd(buffer, bytesRead, marker);
    if (lineEnd === bytesRead && readOffset + bytesRead < size) {
      ({ bytesRead } = await file.read(buffer, 0, SEARCH_PROBE_BYTES, sfenOffset));
      readOffset = sfenOffset;
      marker = 0;
      lineEnd = findLineEnd(buffer, bytesRead, 0);
    }
    const sfenLine = buffer.toString("utf-8", marker, lineEnd);
    const [currentSFEN, ply] = normalizeSFEN(sfenLine);
    if (sfen === currentSFEN) {
      return [readOffset + lineEnd + 1, ply];
    }

    if (sfen < currentSFEN) {
      end = mid;
    } else {
      begin = readOffset + lineEnd + 1;
    }
  }
  return [-1, 0];
}

export async function searchYaneuraOuBookMovesOnTheFly(
  sfen: string,
  file: fs.promises.FileHandle,
  size: number,
): Promise<BookEntry | undefined> {
  // Each concurrent lookup owns its scratch buffer for both probes and moves.
  const buffer = Buffer.allocUnsafe(SEARCH_ENTRY_BYTES);
  const [offset, ply] = await binarySearch(sfen, file, size, buffer);
  if (offset < 0) {
    return;
  }

  const read = await file.read(buffer, 0, buffer.length, offset);
  if (read.bytesRead === 0) {
    return;
  }
  let comment = "";
  const moves: BookMove[] = [];
  let i = 0;
  while (i < read.bytesRead) {
    const lineEnd = findLineEnd(buffer, read.bytesRead, i);
    const moveLine = buffer.toString("utf-8", i, lineEnd);
    i = lineEnd;
    if (i + 1 < read.bytesRead && buffer[i] === CR && buffer[i + 1] === LF) {
      i++;
    }
    i++;
    const parsed = parseLine(moveLine);
    if (parsed.type === "comment") {
      if (moves.length === 0) {
        comment = appendCommentLine(comment, parsed.comment);
      } else {
        const move = moves[moves.length - 1];
        move.comment = appendCommentLine(move.comment, parsed.comment);
      }
      continue;
    } else if (parsed.type === "move") {
      moves.push(parsed.move);
    } else {
      break;
    }
  }
  return { type: "normal", comment, moves, minPly: ply };
}
