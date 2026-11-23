import { isUtf8 } from "node:buffer";

const enum FieldKind {
  Int32 = 1,
  Int64,
  Text,
  Move,
  Eval,
  HashKey,
}

type Fields = Readonly<Partial<Record<number, FieldKind>>>;

// Exact tags, including wire type, from sbk.proto.
const stateFields: Fields = {
  8: FieldKind.Int32, // Id
  16: FieldKind.HashKey, // BoardKey
  24: FieldKind.HashKey, // HandKey
  32: FieldKind.Int32, // Games
  40: FieldKind.Int32, // WonBlack
  48: FieldKind.Int32, // WonWhite
  58: FieldKind.Text, // Position
  66: FieldKind.Text, // Comment
  74: FieldKind.Move,
  82: FieldKind.Eval,
};
const moveFields: Fields = {
  8: FieldKind.Int32,
  16: FieldKind.Int32,
  24: FieldKind.Int32,
  32: FieldKind.Int32,
};
const evalFields: Fields = {
  8: FieldKind.Int32,
  16: FieldKind.Int32,
  24: FieldKind.Int32,
  32: FieldKind.Int64, // Nodes
  42: FieldKind.Text, // Variation
  50: FieldKind.Text, // EngineName
};

function varintEnd(data: Uint8Array, start: number, end: number): number {
  const limit = Math.min(start + 10, end);
  for (let i = start; i < limit; i++) {
    if (data[i] < 0x80) return i + 1;
  }
  return -1;
}

function isCanonicalInt32(data: Uint8Array, start: number, end: number): boolean {
  const size = end - start;
  const last = data[end - 1];
  if (size <= 5) return last !== 0 && (size < 5 || last <= 7);
  // Negative int32 values are sign-extended to 64 bits by the encoder.
  return (
    size === 10 &&
    last === 1 &&
    data[start + 4] >= 0xf8 &&
    data[start + 5] === 0xff &&
    data[start + 6] === 0xff &&
    data[start + 7] === 0xff &&
    data[start + 8] === 0xff
  );
}

function isStableText(data: Uint8Array, start: number, end: number): boolean {
  const hasBom =
    end - start >= 3 &&
    data[start] === 0xef &&
    data[start + 1] === 0xbb &&
    data[start + 2] === 0xbf;
  return !hasBom && isUtf8(data.subarray(start, end));
}

function varintSize(value: number): number {
  let size = 1;
  while (value > 0x7f) {
    value >>>= 7;
    size++;
  }
  return size;
}

function writeVarint(out: Uint8Array, pos: number, value: number): void {
  while (value > 0x7f) {
    out[pos++] = (value & 0x7f) | 0x80;
    value >>>= 7;
  }
  out[pos] = value;
}

// Without an output buffer this only counts bytes. Return -1 for the decoder fallback.
function emitFields(
  data: Uint8Array,
  offset: number,
  end: number,
  fields: Fields,
  out?: Uint8Array,
  pos = 0,
): number {
  let lastTag = 0;
  while (offset < end) {
    const tagOffset = offset++;
    const tag = data[tagOffset];
    const kind = fields[tag];
    const repeated = kind === FieldKind.Move || kind === FieldKind.Eval;
    if (!kind || tag < lastTag || (tag === lastTag && !repeated)) return -1;
    lastTag = tag;

    const valueStart = offset;
    const valueEnd = varintEnd(data, valueStart, end);
    if (valueEnd < 0) return -1;
    offset = valueEnd;
    if (kind === FieldKind.HashKey) continue;
    if (kind === FieldKind.Int32) {
      if (valueEnd - valueStart === 1 && data[valueStart] === 0) continue;
      if (!isCanonicalInt32(data, valueStart, valueEnd)) return -1;
    } else if (kind === FieldKind.Int64) {
      const size = valueEnd - valueStart;
      const last = data[valueEnd - 1];
      if (size === 1 && last === 0) continue;
      if (last === 0 || (size === 10 && last !== 1)) return -1;
    } else {
      const size = valueEnd - valueStart;
      const last = data[valueEnd - 1];
      if (size > 5 || (size === 5 && last > 15) || (size > 1 && last === 0)) return -1;
      let length = 0;
      for (let i = 0; i < size; i++) {
        length |= (data[valueStart + i] & 0x7f) << (i * 7);
      }
      offset = valueEnd + (length >>> 0);
      if (offset > end) return -1;
      if (kind === FieldKind.Text) {
        if (offset === valueEnd) continue;
        if (!isStableText(data, valueEnd, offset)) return -1;
      } else {
        const nested = kind === FieldKind.Move ? moveFields : evalFields;
        // Reserve the old length prefix, then close the gap if the nested message shrinks.
        const nestedStart = out ? pos + 1 + size : 0;
        const nestedEnd = emitFields(data, valueEnd, offset, nested, out, nestedStart);
        if (nestedEnd < 0) return -1;
        const nestedLength = nestedEnd - nestedStart;
        const newSize = varintSize(nestedLength);
        if (out) {
          if (newSize < size) out.copyWithin(pos + 1 + newSize, nestedStart, nestedEnd);
          out[pos] = tag;
          writeVarint(out, pos + 1, nestedLength);
        }
        pos += 1 + newSize + nestedLength;
        continue;
      }
    }
    if (out) out.set(data.subarray(tagOffset, offset), pos);
    pos += offset - tagOffset;
  }
  return pos;
}

/**
 * Use validated SBookState bounds. Return the same bytes as decode, clearing
 * BoardKey/HandKey, and re-encode; otherwise leave encoding to the caller.
 */
export function copySbkStateWithoutHashKeys(
  data: Uint8Array,
  tagOffset: number,
  payloadStart: number,
  payloadEnd: number,
): Uint8Array | undefined {
  if (data[tagOffset] !== 26 || (payloadStart - tagOffset > 2 && data[payloadStart - 1] === 0)) {
    return;
  }
  const originalLength = payloadEnd - payloadStart;
  const length = emitFields(data, payloadStart, payloadEnd, stateFields);
  if (length < 0) return;
  if (length === originalLength) return data.subarray(tagOffset, payloadEnd);

  const headerSize = 1 + varintSize(length);
  // Allow space for the original nested length prefixes during compaction.
  const out = new Uint8Array(headerSize + originalLength);
  out[0] = 26;
  writeVarint(out, 1, length);
  const written = emitFields(data, payloadStart, payloadEnd, stateFields, out, headerSize);
  return written === headerSize + length ? out.subarray(0, written) : undefined;
}
