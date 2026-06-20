import type { Point, RawImage } from "./types.js";

export const letterboxImage = (
  image: RawImage,
  targetW: number,
  targetH: number,
  color: [number, number, number] = [114, 114, 114],
): { image: RawImage; gain: number; padLeft: number; padTop: number } => {
  const srcH = image.height;
  const srcW = image.width;
  const gain = Math.min(targetW / srcW, targetH / srcH);
  const newW = Math.round(srcW * gain);
  const newH = Math.round(srcH * gain);
  const dw = targetW - newW;
  const dh = targetH - newH;
  const padLeft = Math.round(dw / 2 - 0.1);
  const padTop = Math.round(dh / 2 - 0.1);

  const resized = resizeImageRaw(image, newW, newH);

  const canvas = new Uint8Array(targetW * targetH * 4);
  for (let i = 0; i < canvas.length; i += 4) {
    canvas[i] = color[0];
    canvas[i + 1] = color[1];
    canvas[i + 2] = color[2];
    canvas[i + 3] = 255;
  }

  for (let row = 0; row < newH; row++) {
    const srcOffset = row * newW * 4;
    const dstOffset = ((padTop + row) * targetW + padLeft) * 4;
    canvas.set(resized.data.subarray(srcOffset, srcOffset + newW * 4), dstOffset);
  }

  return {
    image: { width: targetW, height: targetH, data: canvas },
    gain,
    padLeft,
    padTop,
  };
};

const resizeImageRaw = (image: RawImage, targetW: number, targetH: number): RawImage => {
  const srcW = image.width;
  const srcH = image.height;
  const dst = new Uint8Array(targetW * targetH * 4);

  for (let dy = 0; dy < targetH; dy++) {
    for (let dx = 0; dx < targetW; dx++) {
      const sx = Math.max(0, Math.min(((dx + 0.5) * srcW) / targetW - 0.5, srcW - 1));
      const sy = Math.max(0, Math.min(((dy + 0.5) * srcH) / targetH - 0.5, srcH - 1));
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
      const dstIdx = (dy * targetW + dx) * 4;

      for (let c = 0; c < 4; c++) {
        const v00 = image.data[srcIdx00 + c];
        const v10 = image.data[srcIdx10 + c];
        const v01 = image.data[srcIdx01 + c];
        const v11 = image.data[srcIdx11 + c];
        dst[dstIdx + c] = Math.round(
          v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy,
        );
      }
    }
  }

  return { width: targetW, height: targetH, data: dst };
};

export const scaleBoxesFromLetterbox = (
  boxes: Float32Array[],
  gain: number,
  padLeft: number,
  padTop: number,
  imageW: number,
  imageH: number,
): Float32Array[] => {
  return boxes.map((box) => {
    const scaled = new Float32Array(4);
    scaled[0] = Math.max(0, Math.min((box[0] - padLeft) / gain, imageW));
    scaled[1] = Math.max(0, Math.min((box[1] - padTop) / gain, imageH));
    scaled[2] = Math.max(0, Math.min((box[2] - padLeft) / gain, imageW));
    scaled[3] = Math.max(0, Math.min((box[3] - padTop) / gain, imageH));
    return scaled;
  });
};

export const orderQuadrilateral = (points: Point[]): Point[] => {
  if (points.length !== 4) {
    throw new Error(`Expected 4 points, got ${points.length}`);
  }

  const cx = points.reduce((s, p) => s + p[0], 0) / 4;
  const cy = points.reduce((s, p) => s + p[1], 0) / 4;

  const indexed = points.map((p) => ({
    p,
    angle: Math.atan2(p[1] - cy, p[0] - cx),
  }));
  indexed.sort((a, b) => a.angle - b.angle);

  const ordered = indexed.map((e) => e.p);
  let startIdx = 0;
  let minSum = Infinity;
  for (let i = 0; i < 4; i++) {
    const sum = ordered[i][0] + ordered[i][1];
    if (sum < minSum) {
      minSum = sum;
      startIdx = i;
    }
  }

  const result: Point[] = [];
  for (let i = 0; i < 4; i++) {
    result.push(ordered[(startIdx + i) % 4]);
  }
  return result;
};

export const getPerspectiveTransform = (src: Point[], dst: Point[]): number[] => {
  const [x0, y0] = src[0];
  const [x1, y1] = src[1];
  const [x2, y2] = src[2];
  const [x3, y3] = src[3];

  const [u0, v0] = dst[0];
  const [u1, v1] = dst[1];
  const [u2, v2] = dst[2];
  const [u3, v3] = dst[3];

  const a = [
    [x0, y0, 1, 0, 0, 0, -u0 * x0, -u0 * y0],
    [0, 0, 0, x0, y0, 1, -v0 * x0, -v0 * y0],
    [x1, y1, 1, 0, 0, 0, -u1 * x1, -u1 * y1],
    [0, 0, 0, x1, y1, 1, -v1 * x1, -v1 * y1],
    [x2, y2, 1, 0, 0, 0, -u2 * x2, -u2 * y2],
    [0, 0, 0, x2, y2, 1, -v2 * x2, -v2 * y2],
    [x3, y3, 1, 0, 0, 0, -u3 * x3, -u3 * y3],
    [0, 0, 0, x3, y3, 1, -v3 * x3, -v3 * y3],
  ];

  const b = [u0, v0, u1, v1, u2, v2, u3, v3];
  const h = solveLinearSystem(a, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
};

const solveLinearSystem = (a: number[][], b: number[]): number[] => {
  const n = b.length;
  const aug = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
        maxRow = row;
      }
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-10) {
      throw new Error("Singular matrix");
    }

    for (let j = col; j <= n; j++) {
      aug[col][j] /= pivot;
    }

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  return aug.map((row) => row[n]);
};

export const warpPerspective = (
  image: RawImage,
  h: number[],
  outW: number,
  outH: number,
): RawImage => {
  const srcW = image.width;
  const srcH = image.height;
  const dst = new Uint8Array(outW * outH * 4);

  const invH = invertMatrix3x3(h);

  for (let dy = 0; dy < outH; dy++) {
    for (let dx = 0; dx < outW; dx++) {
      const wVal = invH[6] * dx + invH[7] * dy + invH[8];
      const sx = (invH[0] * dx + invH[1] * dy + invH[2]) / wVal;
      const sy = (invH[3] * dx + invH[4] * dy + invH[5]) / wVal;

      if (sx < 0 || sy < 0 || sx > srcW - 1 || sy > srcH - 1) continue;

      const x0 = Math.max(0, Math.min(Math.floor(sx), srcW - 1));
      const y0 = Math.max(0, Math.min(Math.floor(sy), srcH - 1));
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = Math.max(0, Math.min(sx - x0, 1));
      const fy = Math.max(0, Math.min(sy - y0, 1));

      const srcIdx00 = (y0 * srcW + x0) * 4;
      const srcIdx10 = (y0 * srcW + x1) * 4;
      const srcIdx01 = (y1 * srcW + x0) * 4;
      const srcIdx11 = (y1 * srcW + x1) * 4;
      const dstIdx = (dy * outW + dx) * 4;

      for (let c = 0; c < 4; c++) {
        const v00 = image.data[srcIdx00 + c];
        const v10 = image.data[srcIdx10 + c];
        const v01 = image.data[srcIdx01 + c];
        const v11 = image.data[srcIdx11 + c];
        dst[dstIdx + c] = Math.round(
          v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy,
        );
      }
    }
  }

  return { width: outW, height: outH, data: dst };
};

const invertMatrix3x3 = (m: number[]): number[] => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-10) {
    throw new Error("Matrix is not invertible");
  }
  const invDet = 1 / det;
  return [
    (e * i - f * h) * invDet,
    (c * h - b * i) * invDet,
    (b * f - c * e) * invDet,
    (f * g - d * i) * invDet,
    (a * i - c * g) * invDet,
    (c * d - a * f) * invDet,
    (d * h - e * g) * invDet,
    (b * g - a * h) * invDet,
    (a * e - b * d) * invDet,
  ];
};

export const nms = (boxes: Float32Array[], scores: number[], iouThreshold: number): number[] => {
  let remaining = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .map((e) => e.i);

  const keep: number[] = [];

  while (remaining.length > 0) {
    const idx = remaining[0];
    keep.push(idx);
    remaining = remaining
      .slice(1)
      .filter((other) => computeIoU(boxes[idx], boxes[other]) < iouThreshold);
  }

  return keep;
};

export const normalizeYoloOutput = (
  data: Float32Array,
  dims: readonly number[] | undefined,
  channels: number,
): Float32Array[] => {
  const view = createYoloOutputView(data, dims, channels);
  const result: Float32Array[] = [];
  for (let anchor = 0; anchor < view.anchors; anchor++) {
    result.push(view.row(anchor));
  }
  return result;
};

export interface YoloOutputView {
  anchors: number;
  channels: number;
  value: (anchor: number, channel: number) => number;
  row: (anchor: number) => Float32Array;
}

export const createYoloOutputView = (
  data: Float32Array,
  dims: readonly number[] | undefined,
  channels: number,
): YoloOutputView => {
  const shape = dims && dims.length === 3 && dims[0] === 1 ? dims.slice(1) : dims;
  let anchors: number;
  let channelMajor: boolean;

  if (shape?.length === 2) {
    if (shape[0] === channels) {
      anchors = shape[1];
      channelMajor = true;
    } else if (shape[1] === channels) {
      anchors = shape[0];
      channelMajor = false;
    } else {
      throw new Error(`Unsupported YOLO output shape: ${shape.join("x")}`);
    }
  } else if (data.length % channels === 0) {
    anchors = data.length / channels;
    channelMajor = true;
  } else {
    throw new Error(`Unsupported YOLO output length: ${data.length}`);
  }

  const value = channelMajor
    ? (anchor: number, channel: number): number => data[channel * anchors + anchor]
    : (anchor: number, channel: number): number => data[anchor * channels + channel];

  return {
    anchors,
    channels,
    value,
    row: (anchor: number): Float32Array => {
      const row = new Float32Array(channels);
      for (let channel = 0; channel < channels; channel++) {
        row[channel] = value(anchor, channel);
      }
      return row;
    },
  };
};

export const computeIoU = (a: Float32Array, b: Float32Array): number => {
  const xmin = Math.max(a[0], b[0]);
  const ymin = Math.max(a[1], b[1]);
  const xmax = Math.min(a[2], b[2]);
  const ymax = Math.min(a[3], b[3]);
  const intersection = Math.max(0, xmax - xmin) * Math.max(0, ymax - ymin);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return intersection / (areaA + areaB - intersection);
};

export const xywh2xyxy = (boxes: Float32Array[]): Float32Array[] => {
  return boxes.map((b) => {
    const out = new Float32Array(4);
    out[0] = b[0] - b[2] / 2;
    out[1] = b[1] - b[3] / 2;
    out[2] = b[0] + b[2] / 2;
    out[3] = b[1] + b[3] / 2;
    return out;
  });
};
