import { beforeEach, describe, expect, it, vi } from "vitest";

const readMock = vi.hoisted(() => vi.fn());

vi.mock("jimp", () => ({
  Jimp: {
    read: readMock,
  },
}));

import { loadImage } from "@/server/vision/node-worker/image-io";

describe("Node vision worker image IO", () => {
  beforeEach(() => {
    readMock.mockReset();
  });

  it("rejects decoded images that are too large", async () => {
    readMock.mockResolvedValue({
      width: 4097,
      height: 32,
      bitmap: { data: new Uint8Array() },
    });

    await expect(loadImage("large.png")).rejects.toThrow("image is too large");
  });

  it("loads decoded images within size limits", async () => {
    const data = new Uint8Array(32 * 32 * 4);
    readMock.mockResolvedValue({
      width: 32,
      height: 32,
      bitmap: { data },
    });

    await expect(loadImage("ok.png")).resolves.toEqual({ width: 32, height: 32, data });
  });
});
