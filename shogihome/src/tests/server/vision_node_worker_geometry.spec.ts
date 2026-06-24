import { describe, expect, it } from "vitest";
import { nms, normalizeYoloOutput, warpPerspective } from "@/server/vision/node-worker/geometry";
import { removePerspective } from "@/server/vision/node-worker/board-splitter";

describe("Node vision worker geometry utilities", () => {
  it("decodes channel-major YOLO outputs as anchor rows", () => {
    const data = new Float32Array([10, 20, 30, 40, 50, 11, 21, 31, 41, 51]);

    const rows = normalizeYoloOutput(data, [1, 5, 2], 5);

    expect(Array.from(rows[0])).toEqual([10, 30, 50, 21, 41]);
    expect(Array.from(rows[1])).toEqual([20, 40, 11, 31, 51]);
  });

  it("keeps anchor-major YOLO outputs as anchor rows", () => {
    const data = new Float32Array([10, 20, 30, 40, 50, 11, 21, 31, 41, 51]);

    const rows = normalizeYoloOutput(data, [1, 2, 5], 5);

    expect(Array.from(rows[0])).toEqual([10, 20, 30, 40, 50]);
    expect(Array.from(rows[1])).toEqual([11, 21, 31, 41, 51]);
  });

  it("suppresses overlapping boxes by sorted score order", () => {
    const keep = nms(
      [
        new Float32Array([0, 0, 10, 10]),
        new Float32Array([1, 1, 11, 11]),
        new Float32Array([30, 30, 40, 40]),
      ],
      [0.8, 0.9, 0.7],
      0.5,
    );

    expect(keep).toEqual([1, 2]);
  });

  it("keeps valid edge pixels when warping with an identity transform", () => {
    const width = 3;
    const height = 3;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = i + 1;
      data[i * 4 + 1] = i + 1;
      data[i * 4 + 2] = i + 1;
      data[i * 4 + 3] = 255;
    }

    const warped = warpPerspective(
      { width, height, data },
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      width,
      height,
    );

    expect(Array.from(warped.data)).toEqual(Array.from(data));
  });

  it("fills board perspective pixels outside the source with a neutral border", () => {
    const width = 4;
    const height = 4;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = 10;
      data[i * 4 + 1] = 20;
      data[i * 4 + 2] = 30;
      data[i * 4 + 3] = 255;
    }

    const warped = removePerspective(
      { width, height, data },
      [
        [5, 0],
        [8, 0],
        [8, 3],
        [5, 3],
      ],
      4,
    );

    expect(Array.from(warped.data.slice(0, 4))).toEqual([114, 114, 114, 255]);
  });
});
