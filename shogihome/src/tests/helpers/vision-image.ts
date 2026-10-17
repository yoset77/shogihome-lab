import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function pngChunk(type: string, data: Buffer): Buffer<ArrayBuffer> {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

export function createTestPng({
  width = 32,
  height = 32,
  depth = 8,
  color = 6,
  interlaced = false,
  raw,
}: {
  width?: number;
  height?: number;
  depth?: number;
  color?: number;
  interlaced?: boolean;
  raw?: Buffer;
} = {}): Buffer<ArrayBuffer> {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = color;
  ihdr[12] = interlaced ? 1 : 0;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const passes = interlaced
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
  let size = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx));
    const h = Math.max(0, Math.ceil((height - y) / dy));
    if (w && h) size += (Math.ceil((w * channels * depth) / 8) + 1) * h;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    ...(color === 3 ? [pngChunk("PLTE", Buffer.alloc(3))] : []),
    pngChunk("IDAT", deflateSync(raw ?? Buffer.alloc(size))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegSegment(marker: number, data: number[]): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([header, Buffer.from(data)]);
}

/** A 32x32 gray image: all DCT coefficients are zero, with one-bit Huffman codes. */
export function createTestJpeg(progressive = false): Buffer<ArrayBuffer> {
  const codes = [1, ...Array<number>(15).fill(0), 0];
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xdb, [0, ...Array<number>(64).fill(1)]),
    jpegSegment(progressive ? 0xc2 : 0xc0, [8, 0, 32, 0, 32, 1, 1, 0x11, 0]),
    jpegSegment(0xc4, [0, ...codes, 0x10, ...codes]),
    jpegSegment(0xda, [1, 1, 0, 0, progressive ? 0 : 63, 0]),
    Buffer.alloc(progressive ? 2 : 4),
    ...(progressive ? [jpegSegment(0xda, [1, 1, 0, 1, 63, 0]), Buffer.alloc(2)] : []),
    Buffer.from([0xff, 0xd9]),
  ]);
}
