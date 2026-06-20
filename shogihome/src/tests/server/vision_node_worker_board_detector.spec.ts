import { describe, expect, it } from "vitest";
import {
  extractCornersFromMask,
  minAreaRectCorners,
} from "@/server/vision/node-worker/board-detector";

describe("Node vision worker board detector", () => {
  it("minAreaRectCorners returns the enclosing rectangle of a rotated shape", () => {
    const diamond: [number, number][] = [
      [5, 0],
      [10, 5],
      [5, 10],
      [0, 5],
    ];

    const corners = minAreaRectCorners(diamond);

    // The corners should reproduce the diamond in cyclic order.
    expect(corners).toHaveLength(4);
    const sorted = [...corners].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(sorted[0][0]).toBeCloseTo(0);
    expect(sorted[0][1]).toBeCloseTo(5);
    expect(sorted[1][0]).toBeCloseTo(5);
    expect(sorted[1][1]).toBeCloseTo(0);
    expect(sorted[2][0]).toBeCloseTo(5);
    expect(sorted[2][1]).toBeCloseTo(10);
    expect(sorted[3][0]).toBeCloseTo(10);
    expect(sorted[3][1]).toBeCloseTo(5);
  });

  it("extractCornersFromMask returns rectangle corners for a rectangular mask", () => {
    const width = 100;
    const height = 100;
    const mask = new Uint8Array(width * height);
    const x1 = 30;
    const y1 = 35;
    const x2 = 70;
    const y2 = 65;
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        mask[y * width + x] = 1;
      }
    }

    const corners = extractCornersFromMask(mask, width, height);

    expect(corners).not.toBeNull();
    const sorted = corners!.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(sorted[0]).toEqual([x1, y1]);
    expect(sorted[1]).toEqual([x1, y2 - 1]);
    expect(sorted[2]).toEqual([x2 - 1, y1]);
    expect(sorted[3]).toEqual([x2 - 1, y2 - 1]);
  });

  it("extractCornersFromMask includes boundary pixels on image edges", () => {
    const width = 100;
    const height = 100;
    const mask = new Uint8Array(width * height).fill(1);

    const corners = extractCornersFromMask(mask, width, height);

    expect(corners).not.toBeNull();
    const sorted = corners!.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(sorted[0]).toEqual([0, 0]);
    expect(sorted[1]).toEqual([0, height - 1]);
    expect(sorted[2]).toEqual([width - 1, 0]);
    expect(sorted[3]).toEqual([width - 1, height - 1]);
  });

  it("extractCornersFromMask falls back to minAreaRect for a circular mask", () => {
    const width = 100;
    const height = 100;
    const mask = new Uint8Array(width * height);
    const cx = 50;
    const cy = 50;
    const radius = 30;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) {
          mask[y * width + x] = 1;
        }
      }
    }

    const corners = extractCornersFromMask(mask, width, height);

    expect(corners).not.toBeNull();
    expect(corners).toHaveLength(4);
    // The fallback should produce an axis-aligned bounding box.
    const xs = corners!.map((p) => p[0]);
    const ys = corners!.map((p) => p[1]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(19);
    expect(Math.max(...xs)).toBeLessThanOrEqual(81);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(19);
    expect(Math.max(...ys)).toBeLessThanOrEqual(81);
  });

  it("extractCornersFromMask returns null for a degenerate mask", () => {
    const width = 100;
    const height = 100;
    const mask = new Uint8Array(width * height);
    mask[50 * width + 50] = 1;

    const corners = extractCornersFromMask(mask, width, height);

    expect(corners).toBeNull();
  });
});
