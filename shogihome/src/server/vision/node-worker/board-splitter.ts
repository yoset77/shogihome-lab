import type { Point, RawImage } from "./types.js";
import { getPerspectiveTransform, warpPerspective } from "./geometry.js";

const BOARD_SIZE = 900;
const BORDER_VALUE: [number, number, number] = [114, 114, 114];

export const removePerspective = (
  image: RawImage,
  corners: [Point, Point, Point, Point],
  boardSize: number = BOARD_SIZE,
): RawImage => {
  const size = boardSize - 1;
  const src = corners;
  const dst: Point[] = [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ];

  const h = getPerspectiveTransform(src, dst);
  return warpPerspective(image, h, boardSize, boardSize, BORDER_VALUE);
};

export const splitCells = (boardImage: RawImage): RawImage[][] => {
  const { width, height } = boardImage;
  const cellW = Math.floor(width / 9);
  const cellH = Math.floor(height / 9);
  const cells: RawImage[][] = [];

  for (let row = 0; row < 9; row++) {
    const rowCells: RawImage[] = [];
    for (let col = 0; col < 9; col++) {
      const x = col * cellW;
      const y = row * cellH;
      const w = col === 8 ? width - x : cellW;
      const h = row === 8 ? height - y : cellH;
      rowCells.push(extractCrop(boardImage, x, y, w, h));
    }
    cells.push(rowCells);
  }

  return cells;
};

const extractCrop = (image: RawImage, x: number, y: number, w: number, h: number): RawImage => {
  const dst = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcOffset = ((y + row) * image.width + x) * 4;
    const dstOffset = row * w * 4;
    dst.set(image.data.subarray(srcOffset, srcOffset + w * 4), dstOffset);
  }
  return { width: w, height: h, data: dst };
};
