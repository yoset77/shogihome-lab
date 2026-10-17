import { createInflate } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_IMAGE_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION;
export const MAX_ENCODED_IMAGE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_CHUNKS = 4096;

export class VisionImageInputError extends Error {
  constructor(readonly reason: "invalid" | "too-large" | "unsupported") {
    super(`Invalid vision image: ${reason}`);
  }
}

type ImageDimensions = { width: number; height: number };
export type ImageInput = ImageDimensions &
  ({ mime: "image/jpeg" } | { mime: "image/png"; idat: Buffer[]; inflatedBytes: number });

export function validateImageDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32) {
    throw new VisionImageInputError("invalid");
  }
  if (
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new VisionImageInputError("too-large");
  }
}

function invalid(): never {
  throw new VisionImageInputError("invalid");
}

function pngInput(data: Buffer): ImageInput {
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let palette = false;
  let idatEnded = false;
  const idat: Buffer[] = [];
  const depths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  for (let chunks = 0; offset < data.length && chunks < MAX_PNG_CHUNKS; chunks++) {
    if (offset + 12 > data.length) invalid();
    const length = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length || !/^[A-Za-z]{4}$/.test(type)) invalid();
    if (chunks === 0 && type !== "IHDR") invalid();
    if (type === "IHDR") {
      if (chunks !== 0 || length !== 13) invalid();
      width = data.readUInt32BE(start);
      height = data.readUInt32BE(start + 4);
      validateImageDimensions(width, height);
      depth = data[start + 8];
      color = data[start + 9];
      interlace = data[start + 12];
      if (
        !depths[color]?.includes(depth) ||
        data[start + 10] !== 0 ||
        data[start + 11] !== 0 ||
        interlace > 1
      )
        invalid();
    } else if (type === "PLTE") {
      if (palette || idat.length || length === 0 || length > 768 || length % 3 !== 0) invalid();
      if (color === 0 || color === 4 || (color === 3 && length / 3 > 2 ** depth)) invalid();
      palette = true;
    } else if (type === "IDAT") {
      if (idatEnded || (color === 3 && !palette)) invalid();
      idat.push(data.subarray(start, end));
    } else if (type === "IEND") {
      if (length !== 0 || end + 4 !== data.length || !idat.length) invalid();
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color as 0 | 2 | 3 | 4 | 6];
      const passes = interlace
        ? [
            [0, 0, 8, 8],
            [4, 0, 8, 8],
            [0, 4, 4, 8],
            [2, 0, 4, 4],
            [0, 2, 2, 4],
            [1, 0, 2, 2],
            [0, 1, 1, 2],
          ]
        : [[0, 0, 1, 1]];
      let inflatedBytes = 0;
      for (const [x, y, dx, dy] of passes) {
        const w = Math.max(0, Math.ceil((width - x) / dx));
        const h = Math.max(0, Math.ceil((height - y) / dy));
        if (w && h) inflatedBytes += (1 + Math.ceil((w * channels * depth) / 8)) * h;
      }
      return { mime: "image/png", width, height, idat, inflatedBytes };
    } else {
      if (idat.length) idatEnded = true;
      if (type === "acTL" || type === "fcTL" || type === "fdAT") {
        throw new VisionImageInputError("unsupported");
      }
      if (type[0] === type[0].toUpperCase()) invalid();
      if (type === "gAMA" && length !== 4) invalid();
      if (
        type === "tRNS" &&
        (idat.length ||
          (color === 3
            ? !palette || length > 256
            : color === 0
              ? length !== 2
              : color === 2
                ? length !== 6
                : true))
      )
        invalid();
    }
    offset = end + 4;
  }
  return invalid();
}

function jpegInput(data: Buffer): ImageInput {
  let offset = 2;
  let dimensions: ImageDimensions | undefined;
  let scanned = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) invalid();
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) {
      if (!dimensions || !scanned || offset !== data.length) invalid();
      return { mime: "image/jpeg", ...dimensions };
    }
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      invalid();
    if (offset + 2 > data.length) invalid();
    const length = data.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > data.length) invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (![0xc0, 0xc1, 0xc2].includes(marker)) throw new VisionImageInputError("unsupported");
      if (dimensions || length < 8) invalid();
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      validateImageDimensions(width, height);
      const components = data[offset + 7];
      if (
        data[offset + 2] !== 8 ||
        ![1, 3, 4].includes(components) ||
        length !== 8 + 3 * components
      )
        invalid();
      const ids = new Set<number>();
      let sampling = 0;
      for (let i = 0; i < components; i++) {
        const pos = offset + 8 + i * 3;
        if (ids.has(data[pos])) invalid();
        ids.add(data[pos]);
        const h = data[pos + 1] >> 4;
        const v = data[pos + 1] & 15;
        if (!h || !v || h > 4 || v > 4 || data[pos + 2] > 3) invalid();
        sampling += h * v;
      }
      if (sampling > 10) invalid();
      dimensions = { width, height };
    }
    offset = end;
    if (marker === 0xda) {
      if (!dimensions) invalid();
      scanned = true;
      // Walk entropy-coded bytes too: a later SOF must not bypass the first dimensions.
      while (offset < data.length) {
        if (data[offset] !== 0xff) {
          offset++;
          continue;
        }
        const start = offset++;
        while (data[offset] === 0xff) offset++;
        const next = data[offset];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
          offset++;
          continue;
        }
        offset = start;
        break;
      }
    }
  }
  return invalid();
}

/** Structural validation only; pixel decoding must use the same buffer. */
export function validateImageInput(data: Buffer, expectedMime?: string): ImageInput {
  if (data.length > MAX_ENCODED_IMAGE_BYTES) throw new VisionImageInputError("too-large");
  const mime = data.subarray(0, 8).equals(PNG_SIGNATURE)
    ? "image/png"
    : data.length >= 2 && data[0] === 0xff && data[1] === 0xd8
      ? "image/jpeg"
      : undefined;
  if (!mime || (expectedMime !== undefined && mime !== expectedMime))
    throw new VisionImageInputError("unsupported");
  return mime === "image/png" ? pngInput(data) : jpegInput(data);
}

/** Validate inflation without retaining its output, including Adam7 PNG data. */
export async function validatePngInflation(input: ImageInput): Promise<void> {
  if (input.mime !== "image/png") return;
  let bytes = 0;
  try {
    await pipeline(
      Readable.from(input.idat),
      createInflate(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          callback(bytes > input.inflatedBytes ? new VisionImageInputError("invalid") : null);
        },
      }),
    );
  } catch {
    throw new VisionImageInputError("invalid");
  }
  if (bytes !== input.inflatedBytes) invalid();
}
