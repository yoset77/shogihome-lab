import type { Point, RawImage, HandOwnerCounts } from "./types.js";
import { loadSession, createTensor } from "./session.js";
import {
  createYoloOutputView,
  getPerspectiveTransform,
  nms,
  rectifiedRegionSize,
  warpPolygonRegion,
  imageMeanColor,
} from "./geometry.js";
import path from "node:path";

const HAND_PIECE_CHARS = ["P", "L", "N", "S", "G", "B", "R"];
const CLASS_TO_PIECE: Record<number, string> = {};
HAND_PIECE_CHARS.forEach((c, i) => (CLASS_TO_PIECE[i] = c));

const DEFAULT_MODEL = "hand_piece_detector.onnx";

interface HandRegion {
  owner: "black" | "white";
  placement: string;
  image: RawImage;
}

export const buildHandRegions = (
  image: RawImage,
  corners: [Point, Point, Point, Point],
): HandRegion[] => {
  const src: Point[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const transform = getPerspectiveTransform(src, corners);

  const gapCells = 0.15 / 9;
  const sideWidth = 4.0 / 9;
  const sideHeight = 4.0 / 9;
  const sideVerticalMargin = 1.5 / 9;

  const specs: Array<{ owner: "black" | "white"; placement: string; polygon: Point[] }> = [
    {
      owner: "black",
      placement: "right",
      polygon: [
        [1 + gapCells, 1 - sideHeight - sideVerticalMargin],
        [1 + sideWidth, 1 - sideHeight - sideVerticalMargin],
        [1 + sideWidth, 1 + sideVerticalMargin],
        [1 + gapCells, 1 + sideVerticalMargin],
      ],
    },
    {
      owner: "white",
      placement: "right",
      polygon: [
        [-sideWidth, -sideVerticalMargin],
        [-gapCells, -sideVerticalMargin],
        [-gapCells, sideHeight + sideVerticalMargin],
        [-sideWidth, sideHeight + sideVerticalMargin],
      ],
    },
  ];

  const borderValue = imageMeanColor(image);
  const regions: HandRegion[] = [];
  for (const spec of specs) {
    const polygon = spec.polygon.map((p) => projectPoint(p, transform));
    const [w, h] = rectifiedRegionSize(corners, spec.polygon);
    if (w < 10 || h < 10) continue;
    const warped = warpPolygonRegion(image, polygon, w, h, borderValue);
    regions.push({ owner: spec.owner, placement: spec.placement, image: warped });
  }
  return regions;
};

const projectPoint = (p: Point, h: number[]): Point => {
  const w = h[6] * p[0] + h[7] * p[1] + h[8];
  return [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w];
};

export const detectHandPieces = async (
  regions: HandRegion[],
  modelDir: string,
): Promise<HandOwnerCounts> => {
  const modelPath = path.join(modelDir, DEFAULT_MODEL);
  const session = await loadSession(modelPath);
  const inputName = session.inputNames[0];
  const outputNames = session.outputNames;

  const blackCounts: Record<string, number> = {};
  const whiteCounts: Record<string, number> = {};

  for (const region of regions) {
    if (region.image.width < 10 || region.image.height < 10) continue;

    const inputSize = 640;
    const srcW = region.image.width;
    const srcH = region.image.height;

    const rgb = resizeToRgbNchw(region.image, inputSize);

    const tensor = createTensor(inputName, rgb, [1, 3, inputSize, inputSize]);
    const results = await session.run({ [inputName]: tensor });
    const output = results[outputNames[0]].data as Float32Array;

    const predictions = createYoloOutputView(output, results[outputNames[0]].dims, 11);
    const detections = filterDetections(predictions, 0.5, 0.5, inputSize, srcW, srcH);

    const target = region.owner === "black" ? blackCounts : whiteCounts;
    for (const classId of detections) {
      let piece = CLASS_TO_PIECE[classId] ?? "";
      if (region.owner === "white") piece = piece.toLowerCase();
      if (piece) target[piece] = (target[piece] ?? 0) + 1;
    }
  }

  return { black: blackCounts, white: whiteCounts };
};

const resizeToRgbNchw = (image: RawImage, inputSize: number): Float32Array => {
  const srcW = image.width;
  const srcH = image.height;
  const rgb = new Float32Array(3 * inputSize * inputSize);

  for (let y = 0; y < inputSize; y++) {
    for (let x = 0; x < inputSize; x++) {
      const sx = Math.max(0, Math.min(((x + 0.5) * srcW) / inputSize - 0.5, srcW - 1));
      const sy = Math.max(0, Math.min(((y + 0.5) * srcH) / inputSize - 0.5, srcH - 1));
      const x0 = Math.min(Math.floor(sx), srcW - 1);
      const y0 = Math.min(Math.floor(sy), srcH - 1);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const outIdx = y * inputSize + x;

      for (let c = 0; c < 3; c++) {
        const v = bilinearChannel(image, x0, y0, x1, y1, fx, fy, c) / 255.0;
        rgb[c * inputSize * inputSize + outIdx] = v;
      }
    }
  }

  return rgb;
};

const bilinearChannel = (
  image: RawImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fx: number,
  fy: number,
  channel: number,
): number => {
  const srcIdx00 = (y0 * image.width + x0) * 4 + channel;
  const srcIdx10 = (y0 * image.width + x1) * 4 + channel;
  const srcIdx01 = (y1 * image.width + x0) * 4 + channel;
  const srcIdx11 = (y1 * image.width + x1) * 4 + channel;
  return (
    image.data[srcIdx00] * (1 - fx) * (1 - fy) +
    image.data[srcIdx10] * fx * (1 - fy) +
    image.data[srcIdx01] * (1 - fx) * fy +
    image.data[srcIdx11] * fx * fy
  );
};

type HandYoloOutputView = ReturnType<typeof createYoloOutputView>;

const filterDetections = (
  predictions: HandYoloOutputView,
  confThreshold: number,
  iouThreshold: number,
  inputSize: number,
  imageW: number,
  imageH: number,
): number[] => {
  const boxes: Float32Array[] = [];
  const scores: number[] = [];
  const classIds: number[] = [];

  for (let anchor = 0; anchor < predictions.anchors; anchor++) {
    let bestClass = 0;
    let score = predictions.value(anchor, 4);
    for (let c = 1; c < HAND_PIECE_CHARS.length; c++) {
      const classScore = predictions.value(anchor, 4 + c);
      if (classScore > score) {
        score = classScore;
        bestClass = c;
      }
    }
    if (score <= confThreshold) continue;

    const cx = predictions.value(anchor, 0);
    const cy = predictions.value(anchor, 1);
    const w = predictions.value(anchor, 2);
    const h = predictions.value(anchor, 3);
    const x1 = ((cx - w / 2) / inputSize) * imageW;
    const y1 = ((cy - h / 2) / inputSize) * imageH;
    const x2 = ((cx + w / 2) / inputSize) * imageW;
    const y2 = ((cy + h / 2) / inputSize) * imageH;
    boxes.push(new Float32Array([x1, y1, x2, y2]));
    scores.push(score);
    classIds.push(bestClass);
  }

  if (boxes.length === 0) return [];

  const keep = nms(boxes, scores, iouThreshold);

  return keep.map((idx) => classIds[idx]);
};
