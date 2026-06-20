import { Jimp } from "jimp";
import type { RawImage } from "./types.js";

export const loadImage = async (imagePath: string): Promise<RawImage> => {
  const image = await Jimp.read(imagePath);
  const width = image.width;
  const height = image.height;

  if (width < 32 || height < 32) {
    throw new Error("image is too small");
  }

  const data = new Uint8Array(image.bitmap.data);
  return { width, height, data };
};

export const resizeImage = (
  image: RawImage,
  targetWidth: number,
  targetHeight: number,
): RawImage => {
  const srcW = image.width;
  const srcH = image.height;
  const dst = new Uint8Array(targetWidth * targetHeight * 4);

  for (let dy = 0; dy < targetHeight; dy++) {
    for (let dx = 0; dx < targetWidth; dx++) {
      const sx = Math.max(0, Math.min(((dx + 0.5) * srcW) / targetWidth - 0.5, srcW - 1));
      const sy = Math.max(0, Math.min(((dy + 0.5) * srcH) / targetHeight - 0.5, srcH - 1));
      const x0 = Math.min(Math.floor(sx), srcW - 1);
      const y0 = Math.min(Math.floor(sy), srcH - 1);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const srcIdx00 = (y0 * srcW + x0) * 4;
      const srcIdx10 = (y0 * srcW + x1) * 4;
      const srcIdx01 = (y1 * srcW + x0) * 4;
      const srcIdx11 = (y1 * srcW + x1) * 4;
      const dstIdx = (dy * targetWidth + dx) * 4;

      for (let c = 0; c < 4; c++) {
        const v00 = image.data[srcIdx00 + c];
        const v10 = image.data[srcIdx10 + c];
        const v01 = image.data[srcIdx01 + c];
        const v11 = image.data[srcIdx11 + c];
        const v =
          v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
        dst[dstIdx + c] = Math.round(v);
      }
    }
  }

  return { width: targetWidth, height: targetHeight, data: dst };
};

export const extractCrop = (
  image: RawImage,
  x: number,
  y: number,
  w: number,
  h: number,
): RawImage => {
  const x1 = Math.max(0, Math.min(x, image.width));
  const y1 = Math.max(0, Math.min(y, image.height));
  const x2 = Math.max(0, Math.min(x + w, image.width));
  const y2 = Math.max(0, Math.min(y + h, image.height));
  const cropW = x2 - x1;
  const cropH = y2 - y1;
  const dst = new Uint8Array(cropW * cropH * 4);

  for (let row = 0; row < cropH; row++) {
    const srcOffset = ((y1 + row) * image.width + x1) * 4;
    const dstOffset = row * cropW * 4;
    dst.set(image.data.subarray(srcOffset, srcOffset + cropW * 4), dstOffset);
  }

  return { width: cropW, height: cropH, data: dst };
};
