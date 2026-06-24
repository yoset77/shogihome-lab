import { describe, expect, it } from "vitest";
import type { Point, RawImage } from "@/server/vision/node-worker/types";
import {
  imageMeanColor,
  rectifiedRegionSize,
  warpPolygonRegion,
  warpPerspective,
} from "@/server/vision/node-worker/geometry";
import { buildHandRegions } from "@/server/vision/node-worker/hand-detector";

const makeImage = (width: number, height: number, fill: [number, number, number]): RawImage => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
};

const gradientImage = (width: number, height: number): RawImage => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = x % 256;
      data[idx + 1] = y % 256;
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }
  return { width, height, data };
};

describe("rectifiedRegionSize", () => {
  it("matches ShogiVision formula for a 900px square board and 4.0/4.0/1.5 cell hand region", () => {
    const corners: [Point, Point, Point, Point] = [
      [0, 0],
      [900, 0],
      [900, 900],
      [0, 900],
    ];
    const gap = 0.15 / 9;
    const sideWidth = 4.0 / 9;
    const sideHeight = 4.0 / 9;
    const sideVerticalMargin = 1.5 / 9;
    const polygon: Point[] = [
      [1 + gap, 1 - sideHeight - sideVerticalMargin],
      [1 + sideWidth, 1 - sideHeight - sideVerticalMargin],
      [1 + sideWidth, 1 + sideVerticalMargin],
      [1 + gap, 1 + sideVerticalMargin],
    ];

    const [w, h] = rectifiedRegionSize(corners, polygon);
    // (4.0 - 0.15) / 9 * 9 * 100 = 385
    // (4.0 + 1.5 + 1.5) / 9 * 9 * 100 = 700
    expect(w).toBe(385);
    expect(h).toBe(700);
  });

  it("uses the average of all four board edges for cell pixel size", () => {
    const corners: [Point, Point, Point, Point] = [
      [0, 0],
      [180, 0],
      [180, 720],
      [0, 720],
    ];
    // top = 180, bottom = 180, right = 720, left = 720, mean = 450, cellPx = 50
    const polygon: Point[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const [w, h] = rectifiedRegionSize(corners, polygon);
    expect(w).toBe(450);
    expect(h).toBe(450);
  });

  it("clamps degenerate boards to a minimum cell pixel size and a minimum output size", () => {
    const corners: [Point, Point, Point, Point] = [
      [10, 10],
      [10, 10],
      [10, 10],
      [10, 10],
    ];
    // All edges are 0 -> cellPx is clamped to 1.0.
    // A unit normalized polygon (1x1) yields 9x9 with cellPx=1.
    const unitPolygon: Point[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(rectifiedRegionSize(corners, unitPolygon)).toEqual([9, 9]);

    // A near-zero polygon rounds to 0 and is clamped to 1.
    const tinyPolygon: Point[] = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0, 0.001],
    ];
    expect(rectifiedRegionSize(corners, tinyPolygon)).toEqual([1, 1]);
  });
});

describe("imageMeanColor", () => {
  it("returns the per-channel RGB average", () => {
    const image = gradientImage(2, 2);
    // R: 0,1,0,1 -> avg 0; G: 0,0,1,1 -> avg 0; B: 128
    expect(imageMeanColor(image)).toEqual([0, 0, 128]);
  });

  it("returns the fill color for a uniform image", () => {
    const image = makeImage(5, 7, [12, 34, 56]);
    expect(imageMeanColor(image)).toEqual([12, 34, 56]);
  });
});

describe("warpPolygonRegion", () => {
  it("copies source pixels when polygon is already an axis-aligned rectangle", () => {
    const image = gradientImage(200, 100);
    const polygon: Point[] = [
      [10, 20],
      [110, 20],
      [110, 70],
      [10, 70],
    ];
    const outW = 101;
    const outH = 51;

    const warped = warpPolygonRegion(image, polygon, outW, outH, [0, 0, 0]);

    expect(warped.width).toBe(outW);
    expect(warped.height).toBe(outH);
    for (let dy = 0; dy < outH; dy++) {
      for (let dx = 0; dx < outW; dx++) {
        const srcIdx = ((20 + dy) * image.width + (10 + dx)) * 4;
        const dstIdx = (dy * outW + dx) * 4;
        expect(warped.data[dstIdx]).toBe(image.data[srcIdx]);
        expect(warped.data[dstIdx + 1]).toBe(image.data[srcIdx + 1]);
        expect(warped.data[dstIdx + 2]).toBe(image.data[srcIdx + 2]);
        expect(warped.data[dstIdx + 3]).toBe(255);
      }
    }
  });

  it("fills outside-sample pixels with the provided border color", () => {
    const image = makeImage(10, 10, [200, 100, 50]);
    // Polygon extends outside the image, so some output samples fall outside.
    const polygon: Point[] = [
      [-5, -5],
      [5, -5],
      [5, 5],
      [-5, 5],
    ];
    const outW = 11;
    const outH = 11;

    const warped = warpPolygonRegion(image, polygon, outW, outH, [9, 8, 7]);

    // Corners (dx=0, dy=0) map to sx=-5, sy=-5 -> border color.
    const cornerIdx = (0 * outW + 0) * 4;
    expect(warped.data[cornerIdx]).toBe(9);
    expect(warped.data[cornerIdx + 1]).toBe(8);
    expect(warped.data[cornerIdx + 2]).toBe(7);
    expect(warped.data[cornerIdx + 3]).toBe(255);
    // Center (dx=5, dy=5) maps to sx=0, sy=0 -> source pixel.
    const centerIdx = (5 * outW + 5) * 4;
    expect(warped.data[centerIdx]).toBe(200);
    expect(warped.data[centerIdx + 1]).toBe(100);
    expect(warped.data[centerIdx + 2]).toBe(50);
  });
});

describe("warpPerspective borderValue", () => {
  it("leaves out-of-range pixels transparent when borderValue is omitted", () => {
    const image = makeImage(4, 4, [10, 20, 30]);
    // Translate output by +5 in x; all samples fall outside source.
    const h = [1, 0, 5, 0, 1, 0, 0, 0, 1];
    const warped = warpPerspective(image, h, 4, 4);
    expect(warped.data.every((v) => v === 0)).toBe(true);
  });
});

describe("buildHandRegions", () => {
  it("produces rectified regions whose size matches rectifiedRegionSize for each owner", () => {
    const image = makeImage(1000, 1000, [80, 120, 160]);
    const corners: [Point, Point, Point, Point] = [
      [50, 50],
      [950, 50],
      [950, 950],
      [50, 950],
    ];

    const regions = buildHandRegions(image, corners);
    expect(regions).toHaveLength(2);

    const black = regions.find((r) => r.owner === "black");
    const white = regions.find((r) => r.owner === "white");
    expect(black).toBeDefined();
    expect(white).toBeDefined();

    const gap = 0.15 / 9;
    const sideWidth = 4.0 / 9;
    const sideHeight = 4.0 / 9;
    const sideVerticalMargin = 1.5 / 9;
    const blackPolygon: Point[] = [
      [1 + gap, 1 - sideHeight - sideVerticalMargin],
      [1 + sideWidth, 1 - sideHeight - sideVerticalMargin],
      [1 + sideWidth, 1 + sideVerticalMargin],
      [1 + gap, 1 + sideVerticalMargin],
    ];
    const whitePolygon: Point[] = [
      [-sideWidth, -sideVerticalMargin],
      [-gap, -sideVerticalMargin],
      [-gap, sideHeight + sideVerticalMargin],
      [-sideWidth, sideHeight + sideVerticalMargin],
    ];
    const [expectedBlackW, expectedBlackH] = rectifiedRegionSize(corners, blackPolygon);
    const [expectedWhiteW, expectedWhiteH] = rectifiedRegionSize(corners, whitePolygon);

    expect(black!.image.width).toBe(expectedBlackW);
    expect(black!.image.height).toBe(expectedBlackH);
    expect(white!.image.width).toBe(expectedWhiteW);
    expect(white!.image.height).toBe(expectedWhiteH);
  });

  it("skips regions that would be smaller than 10px in either dimension", () => {
    const image = makeImage(20, 20, [0, 0, 0]);
    const corners: [Point, Point, Point, Point] = [
      [0, 0],
      [9, 0],
      [9, 9],
      [0, 9],
    ];

    const regions = buildHandRegions(image, corners);
    expect(regions).toHaveLength(0);
  });
});
