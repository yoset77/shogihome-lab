// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { Jimp } from "jimp";
import { loadImage } from "@/server/vision/node-worker/image-io";
import { getTempPathForTesting } from "@/tests/helpers/temp";
import { createTestJpeg, createTestPng, pngChunk } from "@/tests/helpers/vision-image";
import {
  MAX_IMAGE_PIXELS,
  validateImageInput,
  validatePngInflation,
} from "@/server/vision/image-input";

let sequence = 0;
async function imageFile(data: Buffer): Promise<string> {
  const file = path.join(getTempPathForTesting(), `vision-${sequence++}.img`);
  await fs.writeFile(file, data);
  return file;
}

afterEach(() => vi.restoreAllMocks());

it("rejects a small compressed oversized PNG before calling the pixel decoder", async () => {
  const encoded = createTestPng({ width: 5120, height: 5120, depth: 1, color: 0 });
  expect(encoded.length).toBeLessThan(4000);
  const decode = vi.spyOn(Jimp, "fromBuffer");
  await expect(loadImage(await imageFile(encoded))).rejects.toMatchObject({ reason: "too-large" });
  expect(decode).not.toHaveBeenCalled();
});

it.each([false, true])(
  "bounds PNG inflation before pixel decoding (interlaced=%s)",
  async (interlaced) => {
    const encoded = createTestPng({ interlaced, raw: Buffer.alloc(1024 * 1024) });
    const decode = vi.spyOn(Jimp, "fromBuffer");
    await expect(loadImage(await imageFile(encoded))).rejects.toMatchObject({ reason: "invalid" });
    expect(decode).not.toHaveBeenCalled();
  },
);

it.each([
  { name: "normal PNG", data: () => createTestPng() },
  { name: "Adam7 PNG", data: () => createTestPng({ width: 33, height: 37, interlaced: true }) },
  { name: "16-bit PNG", data: () => createTestPng({ depth: 16 }) },
  { name: "indexed PNG", data: () => createTestPng({ depth: 1, color: 3 }) },
  { name: "baseline JPEG", data: () => createTestJpeg() },
  { name: "progressive JPEG", data: () => createTestJpeg(true) },
])("loads a $name with consistent RGBA data", async ({ data }) => {
  const image = await loadImage(await imageFile(data()));
  expect(image.width).toBeGreaterThanOrEqual(32);
  expect(image.data).toHaveLength(image.width * image.height * 4);
});

it("passes explicit JPEG resolution and memory limits to Jimp", async () => {
  const decode = vi.spyOn(Jimp, "fromBuffer");
  await loadImage(await imageFile(createTestJpeg()));
  expect(decode).toHaveBeenCalledWith(expect.any(Buffer), {
    "image/jpeg": { maxResolutionInMP: MAX_IMAGE_PIXELS / 1_000_000, maxMemoryUsageInMB: 512 },
  });
});

it("rejects duplicate IHDR, oversized palettes and truncated chunk lengths", () => {
  const png = createTestPng();
  const duplicated = Buffer.concat([png.subarray(0, 33), png.subarray(8, 33), png.subarray(33)]);
  expect(() => validateImageInput(duplicated)).toThrow();
  const palette = Buffer.concat([
    png.subarray(0, 33),
    pngChunk("PLTE", Buffer.alloc(771)),
    png.subarray(33),
  ]);
  expect(() => validateImageInput(palette)).toThrow();
  const truncated = Buffer.from(png);
  truncated.writeUInt32BE(0xffffffff, 33);
  expect(() => validateImageInput(truncated)).toThrow();
});

it("rejects repeated JPEG frames, oversized dimensions and truncated segments", () => {
  const jpeg = createTestJpeg();
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  const duplicated = Buffer.concat([
    jpeg.subarray(0, sof + 13),
    jpeg.subarray(sof, sof + 13),
    jpeg.subarray(sof + 13),
  ]);
  expect(() => validateImageInput(duplicated)).toThrow();
  const oversized = Buffer.from(jpeg);
  oversized.writeUInt16BE(65535, sof + 5);
  expect(() => validateImageInput(oversized)).toThrow();
  const truncated = Buffer.from(jpeg);
  truncated.writeUInt16BE(65535, 4);
  expect(() => validateImageInput(truncated)).toThrow();
});

it("rejects short PNG inflation and MIME spoofing", async () => {
  const short = validateImageInput(createTestPng({ raw: Buffer.alloc(1) }));
  await expect(validatePngInflation(short)).rejects.toThrow();
  expect(() => validateImageInput(createTestJpeg(), "image/png")).toThrow();
  expect(() => validateImageInput(Buffer.from("GIF89a"))).toThrow();
});

it("checks the decoder output even after valid preflight", async () => {
  vi.spyOn(Jimp, "fromBuffer").mockResolvedValue({
    width: 32,
    height: 32,
    bitmap: { data: Buffer.alloc(1) },
  } as never);
  await expect(loadImage(await imageFile(createTestPng()))).rejects.toMatchObject({
    reason: "invalid",
  });
});

it("continues loading valid images after rejected input", async () => {
  await expect(
    loadImage(await imageFile(createTestPng({ raw: Buffer.alloc(1) }))),
  ).rejects.toThrow();
  await expect(loadImage(await imageFile(createTestPng()))).resolves.toMatchObject({
    width: 32,
    height: 32,
  });
});
