import type { BoardDetection, Point, RawImage } from "./types.js";
import {
  letterboxImage,
  scaleBoxesFromLetterbox,
  orderQuadrilateral,
  nms,
  xywh2xyxy,
  createYoloOutputView,
} from "./geometry.js";
import { loadSession, createTensor } from "./session.js";
import path from "node:path";

const DEFAULT_MODEL = "board_segmenter.onnx";

export const detectBoard = async (image: RawImage, modelDir: string): Promise<BoardDetection> => {
  const modelPath = path.join(modelDir, DEFAULT_MODEL);

  const session = await loadSession(modelPath);
  const inputName = session.inputNames[0];
  const outputNames = session.outputNames;

  const inputHeight = 640;
  const inputWidth = 640;

  const { image: padded, gain, padLeft, padTop } = letterboxImage(image, inputWidth, inputHeight);

  const rgb = new Float32Array(3 * inputWidth * inputHeight);
  for (let i = 0; i < inputWidth * inputHeight; i++) {
    rgb[i] = padded.data[i * 4] / 255.0;
    rgb[inputWidth * inputHeight + i] = padded.data[i * 4 + 1] / 255.0;
    rgb[2 * inputWidth * inputHeight + i] = padded.data[i * 4 + 2] / 255.0;
  }

  const tensor = createTensor(inputName, rgb, [1, 3, inputHeight, inputWidth]);
  const results = await session.run({ [inputName]: tensor });

  const boxOutput = results[outputNames[0]];
  const prototype = results[outputNames[1]];

  const boxData = boxOutput.data as Float32Array;
  const protoData = prototype.data as Float32Array;

  const predictions = createYoloOutputView(boxData, boxOutput.dims, 37);
  if (predictions.anchors === 0) {
    return boardNotFound(image);
  }

  const confidenceThreshold = 0.7;
  const iouThreshold = 0.5;
  const protoSize = 160;

  const scores: number[] = [];
  const maskCoeffs: Float32Array[] = [];
  const boxes: Float32Array[] = [];

  for (let i = 0; i < predictions.anchors; i++) {
    const score = predictions.value(i, 4);
    if (score <= confidenceThreshold) continue;

    scores.push(score);
    boxes.push(
      new Float32Array([
        predictions.value(i, 0),
        predictions.value(i, 1),
        predictions.value(i, 2),
        predictions.value(i, 3),
      ]),
    );

    const coeffs = new Float32Array(predictions.channels - 5);
    for (let channel = 5; channel < predictions.channels; channel++) {
      coeffs[channel - 5] = predictions.value(i, channel);
    }
    maskCoeffs.push(coeffs);
  }

  if (scores.length === 0) {
    return boardNotFound(image);
  }

  const inputBoxes = xywh2xyxy(boxes);
  const keep = nms(inputBoxes, scores, iouThreshold);

  if (keep.length === 0) {
    return boardNotFound(image);
  }

  const bestIdx = keep[0];
  const bestScore = scores[bestIdx];
  const bestCoeffs = maskCoeffs[bestIdx];
  const bestInputBox = inputBoxes[bestIdx];

  const mask = buildMask(
    bestCoeffs,
    protoData,
    protoSize,
    inputHeight,
    inputWidth,
    image.width,
    image.height,
    gain,
    padLeft,
    padTop,
    bestInputBox,
  );

  const corners = extractCornersFromMask(mask, image.width, image.height);
  if (corners) {
    return {
      corners,
      confidence: bestScore,
      warnings: [],
    };
  }

  return boardNotFound(image);
};

const buildMask = (
  coeffs: Float32Array,
  proto: Float32Array,
  protoSize: number,
  inputH: number,
  inputW: number,
  imageW: number,
  imageH: number,
  gain: number,
  padLeft: number,
  padTop: number,
  box: Float32Array,
): Uint8Array => {
  const bx1 = box[0];
  const by1 = box[1];
  const bx2 = box[2];
  const by2 = box[3];

  const sx1f = (bx1 / inputW) * protoSize;
  const sy1f = (by1 / inputH) * protoSize;
  const sx2f = (bx2 / inputW) * protoSize;
  const sy2f = (by2 / inputH) * protoSize;

  const sx1 = Math.max(0, Math.floor(sx1f));
  const sy1 = Math.max(0, Math.floor(sy1f));
  const sx2 = Math.min(protoSize, Math.ceil(sx2f));
  const sy2 = Math.min(protoSize, Math.ceil(sy2f));

  if (sx2 <= sx1 || sy2 <= sy1) {
    return new Uint8Array(imageW * imageH);
  }

  const cropW = sx2 - sx1;
  const cropH = sy2 - sy1;
  const cropLogits = new Float32Array(cropH * cropW);
  for (let y = sy1; y < sy2; y++) {
    for (let x = sx1; x < sx2; x++) {
      let logit = 0;
      for (let i = 0; i < coeffs.length; i++) {
        logit += coeffs[i] * proto[i * protoSize * protoSize + y * protoSize + x];
      }
      cropLogits[(y - sy1) * cropW + (x - sx1)] = logit;
    }
  }

  const ibx1 = Math.max(0, Math.floor(bx1));
  const iby1 = Math.max(0, Math.floor(by1));
  const ibx2 = Math.min(inputW, Math.ceil(bx2));
  const iby2 = Math.min(inputH, Math.ceil(by2));
  const boxW = ibx2 - ibx1;
  const boxH = iby2 - iby1;

  if (boxW <= 0 || boxH <= 0) {
    return new Uint8Array(imageW * imageH);
  }

  const resizedLogits = bilinearResize(cropLogits, cropW, cropH, boxW, boxH);

  const fullInput = new Float32Array(inputW * inputH);
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      fullInput[(iby1 + y) * inputW + (ibx1 + x)] = resizedLogits[y * boxW + x];
    }
  }

  const resizedH = Math.round(imageH * gain);
  const resizedW = Math.round(imageW * gain);
  const maskOrig = bilinearResize(
    cropRegion(fullInput, inputW, inputH, padTop, padTop + resizedH, padLeft, padLeft + resizedW),
    resizedW,
    resizedH,
    imageW,
    imageH,
  );

  const boxImg = scaleBoxesFromLetterbox([box], gain, padLeft, padTop, imageW, imageH)[0];
  const ix1 = Math.max(0, Math.floor(boxImg[0]));
  const iy1 = Math.max(0, Math.floor(boxImg[1]));
  const ix2 = Math.min(imageW, Math.ceil(boxImg[2]));
  const iy2 = Math.min(imageH, Math.ceil(boxImg[3]));

  const mask = new Uint8Array(imageW * imageH);
  for (let y = iy1; y < iy2; y++) {
    for (let x = ix1; x < ix2; x++) {
      const idx = y * imageW + x;
      if (maskOrig[idx] > 0.0) {
        mask[idx] = 1;
      }
    }
  }
  return mask;
};

const bilinearResize = (
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array => {
  const dst = new Float32Array(dstW * dstH);
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.max(0, Math.min(((dx + 0.5) * srcW) / dstW - 0.5, srcW - 1));
      const sy = Math.max(0, Math.min(((dy + 0.5) * srcH) / dstH - 0.5, srcH - 1));
      const x0 = Math.min(Math.floor(sx), srcW - 1);
      const y0 = Math.min(Math.floor(sy), srcH - 1);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const v00 = src[y0 * srcW + x0];
      const v10 = src[y0 * srcW + x1];
      const v01 = src[y1 * srcW + x0];
      const v11 = src[y1 * srcW + x1];
      dst[dy * dstW + dx] =
        v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  }
  return dst;
};

const cropRegion = (
  src: Float32Array,
  srcW: number,
  srcH: number,
  y1: number,
  y2: number,
  x1: number,
  x2: number,
): Float32Array => {
  const w = x2 - x1;
  const h = y2 - y1;
  const dst = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      dst[row * w + col] = src[(y1 + row) * srcW + (x1 + col)];
    }
  }
  return dst;
};

export const minAreaRectCorners = (points: Point[]): Point[] => {
  let bestArea = Infinity;
  let best: Point[] | null = null;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      const x = point[0] * cos - point[1] * sin;
      const y = point[0] * sin + point[1] * cos;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    const area = (maxX - minX) * (maxY - minY);
    if (area >= bestArea) continue;

    const invCos = Math.cos(angle);
    const invSin = Math.sin(angle);
    const rotated: Point[] = [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ];
    best = rotated.map(([x, y]) => [x * invCos - y * invSin, x * invSin + y * invCos]);
    bestArea = area;
  }

  if (best === null) {
    throw new Error("Could not approximate mask rectangle");
  }
  return best;
};

export const extractCornersFromMask = (
  mask: Uint8Array,
  imageW: number,
  imageH: number,
): [Point, Point, Point, Point] | null => {
  const componentMask = largestConnectedComponentMask(mask, imageW, imageH);
  if (componentMask === null) return null;

  const boundary = extractBoundary(componentMask, imageW, imageH);
  if (boundary.length < 4) return null;

  const hull = convexHull(boundary);
  if (hull.length < 4) return null;

  const perimeter = polygonPerimeter(hull);
  const diameter = findDiameterIndices(hull);
  for (const epsilonRatio of [0.008, 0.01, 0.015, 0.02, 0.03, 0.04, 0.06, 0.08]) {
    const splitSimplified = douglasPeuckerClosedByDiameter(
      hull,
      epsilonRatio * perimeter,
      diameter,
    );
    if (splitSimplified.length === 4) {
      return orderQuadrilateral(splitSimplified) as [Point, Point, Point, Point];
    }

    const simplified = douglasPeuckerClosed(hull, epsilonRatio * perimeter);
    if (simplified.length === 4) {
      return orderQuadrilateral(simplified) as [Point, Point, Point, Point];
    }
  }

  // Fallback to the minimum-area enclosing rectangle, matching Python's cv2.minAreaRect.
  return orderQuadrilateral(minAreaRectCorners(hull)) as [Point, Point, Point, Point];
};

const largestConnectedComponentMask = (
  mask: Uint8Array,
  imageW: number,
  imageH: number,
): Uint8Array | null => {
  const visited = new Uint8Array(mask.length);
  let bestComponent: number[] = [];
  let positivePixels = 0;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0) continue;
    positivePixels++;
    if (visited[start] !== 0) continue;

    const component: number[] = [];
    const stack = [start];
    visited[start] = 1;

    while (stack.length > 0) {
      const idx = stack.pop();
      if (idx === undefined) break;
      component.push(idx);

      const x = idx % imageW;
      const y = Math.floor(idx / imageW);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= imageH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= imageW) continue;

          const next = ny * imageW + nx;
          if (mask[next] === 0 || visited[next] !== 0) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }

    if (component.length > bestComponent.length) {
      bestComponent = component;
    }
  }

  if (positivePixels === 0) return null;
  if (bestComponent.length === positivePixels) return mask;

  const filtered = new Uint8Array(mask.length);
  for (const idx of bestComponent) {
    filtered[idx] = 1;
  }
  return filtered;
};

const douglasPeuckerClosed = (points: Point[], epsilon: number): Point[] => {
  if (points.length <= 2) return [...points];

  const closed = [...points, points[0]];
  const simplified = douglasPeucker(closed, epsilon);
  const last = simplified[simplified.length - 1];
  if (last && pointsEqual(simplified[0], last)) {
    simplified.pop();
  }
  return simplified;
};

const findDiameterIndices = (points: Point[]): [number, number] => {
  let firstIdx = 0;
  let secondIdx = 1;
  let maxDist = -Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dist = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
      if (dist > maxDist) {
        maxDist = dist;
        firstIdx = i;
        secondIdx = j;
      }
    }
  }
  return [firstIdx, secondIdx];
};

const douglasPeuckerClosedByDiameter = (
  points: Point[],
  epsilon: number,
  diameter: [number, number] = findDiameterIndices(points),
): Point[] => {
  if (points.length <= 2) return [...points];

  const [firstIdx, secondIdx] = diameter;

  const arcA = points.slice(firstIdx, secondIdx + 1);
  const arcB = [...points.slice(secondIdx), ...points.slice(0, firstIdx + 1)];
  const simplifiedA = douglasPeucker(arcA, epsilon);
  const simplifiedB = douglasPeucker(arcB, epsilon);
  return [...simplifiedA.slice(0, -1), ...simplifiedB.slice(0, -1)];
};

const pointsEqual = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];

const polygonPerimeter = (points: Point[]): number => {
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    perimeter += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  return perimeter;
};

const extractBoundary = (mask: Uint8Array, imageW: number, imageH: number): Point[] => {
  const boundary: Point[] = [];
  for (let y = 0; y < imageH; y++) {
    for (let x = 0; x < imageW; x++) {
      if (mask[y * imageW + x] === 0) continue;
      if (
        y === 0 ||
        y === imageH - 1 ||
        x === 0 ||
        x === imageW - 1 ||
        mask[(y - 1) * imageW + x] === 0 ||
        mask[(y + 1) * imageW + x] === 0 ||
        mask[y * imageW + x - 1] === 0 ||
        mask[y * imageW + x + 1] === 0
      ) {
        boundary.push([x, y]);
      }
    }
  }
  return boundary;
};

const convexHull = (points: Point[]): Point[] => {
  if (points.length < 3) return [...points];

  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cross = (o: Point, a: Point, b: Point): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
};

const douglasPeucker = (points: Point[], epsilon: number): Point[] => {
  if (points.length <= 2) return [...points];

  let maxDist = 0;
  let maxIdx = 0;

  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
};

const pointLineDistance = (p: Point, a: Point, b: Point): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
};

const boardNotFound = (image: RawImage): BoardDetection => {
  const fallback = orderQuadrilateral([
    [0, 0],
    [image.width - 1, 0],
    [image.width - 1, image.height - 1],
    [0, image.height - 1],
  ]);
  return {
    corners: fallback as [Point, Point, Point, Point],
    confidence: 0.0,
    warnings: [{ code: "BOARD_NOT_FOUND", message: "Board outline was not detected." }],
  };
};
