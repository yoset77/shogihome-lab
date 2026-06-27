import { beforeEach, describe, expect, it, vi } from "vitest";
import { compressImageForVision } from "@/renderer/helpers/image";

describe("renderer/helpers/image", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalCreateImageBitmap = global.createImageBitmap;

  const mockCtx = {
    drawImage: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
  };

  const mockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(),
    toBlob: vi.fn(),
  };

  const createMockCanvas = () => {
    mockCanvas.width = 0;
    mockCanvas.height = 0;
    mockCanvas.getContext.mockReturnValue(mockCtx);
    mockCanvas.toBlob.mockImplementation((callback) => {
      callback(new Blob(["jpeg"], { type: "image/jpeg" }));
    });
    return mockCanvas as unknown as HTMLCanvasElement;
  };

  const createMockBitmap = (width: number, height: number) => {
    return {
      width,
      height,
      close: vi.fn(),
    } as unknown as ImageBitmap;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx.drawImage.mockClear();
    mockCtx.imageSmoothingEnabled = false;
    mockCtx.imageSmoothingQuality = "low";
    mockCanvas.width = 0;
    mockCanvas.height = 0;
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
    global.createImageBitmap = originalCreateImageBitmap;
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    global.createImageBitmap = originalCreateImageBitmap;
  });

  it("rejects unsupported image types", async () => {
    const blob = new Blob(["gif"], { type: "image/gif" });
    await expect(compressImageForVision(blob)).rejects.toThrow("Unsupported image type");
  });

  it("rejects WebP images", async () => {
    const blob = new Blob(["webp"], { type: "image/webp" });
    global.createImageBitmap = vi.fn() as unknown as typeof createImageBitmap;

    await expect(compressImageForVision(blob)).rejects.toThrow(
      "Unsupported image type: image/webp",
    );
    expect(global.createImageBitmap).not.toHaveBeenCalled();
  });

  it("re-encodes small images instead of returning the original blob", async () => {
    const originalCreateElement = document.createElement.bind(document);
    const blob = new Blob(["png"], { type: "image/png" });
    const bitmap = createMockBitmap(800, 600);
    global.createImageBitmap = vi.fn(async () => bitmap) as unknown as typeof createImageBitmap;
    const mockCreateElement = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return createMockCanvas();
        }
        return originalCreateElement(tagName);
      });

    const result = await compressImageForVision(blob);

    expect(result).not.toBe(blob);
    expect(result.type).toBe("image/jpeg");
    expect(bitmap.close).toHaveBeenCalled();
    expect(global.createImageBitmap).toHaveBeenCalledWith(blob, { imageOrientation: "from-image" });
    expect(mockCanvas.width).toBe(800);
    expect(mockCanvas.height).toBe(600);
    expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.9);

    mockCreateElement.mockRestore();
  });

  it("resize path: uses createImageBitmap resize options for large images", async () => {
    const originalCreateElement = document.createElement.bind(document);
    const blob = new Blob(["jpeg"], { type: "image/jpeg" });
    const fullBitmap = createMockBitmap(4032, 3024);
    const resizedBitmap = createMockBitmap(1280, 960);

    global.createImageBitmap = vi.fn(
      async (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        if (source === blob) {
          expect(options).toEqual({ imageOrientation: "from-image" });
          return fullBitmap;
        }
        if (source === fullBitmap) {
          expect(options).toEqual({
            resizeWidth: 1280,
            resizeHeight: 960,
            resizeQuality: "medium",
          });
          return resizedBitmap;
        }
        throw new Error("unexpected createImageBitmap source");
      },
    ) as unknown as typeof createImageBitmap;

    const mockCreateElement = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return createMockCanvas();
        }
        return originalCreateElement(tagName);
      });

    const result = await compressImageForVision(blob);

    expect(result.type).toBe("image/jpeg");
    expect(mockCanvas.width).toBe(1280);
    expect(mockCanvas.height).toBe(960);
    expect(mockCtx.imageSmoothingEnabled).toBe(true);
    expect(mockCtx.imageSmoothingQuality).toBe("medium");
    expect(mockCtx.drawImage).toHaveBeenCalledWith(resizedBitmap, 0, 0, 1280, 960);
    expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.9);
    expect(fullBitmap.close).toHaveBeenCalled();
    expect(resizedBitmap.close).toHaveBeenCalled();

    mockCreateElement.mockRestore();
  });

  it("falls back to canvas scaling when createImageBitmap resize fails", async () => {
    const originalCreateElement = document.createElement.bind(document);
    const blob = new Blob(["jpeg"], { type: "image/jpeg" });
    const fullBitmap = createMockBitmap(1920, 1080);

    global.createImageBitmap = vi.fn(
      async (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        if (source === blob) {
          expect(options).toEqual({ imageOrientation: "from-image" });
          return fullBitmap;
        }
        // Resize call fails.
        throw new Error("resize not supported");
      },
    ) as unknown as typeof createImageBitmap;

    const mockCreateElement = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return createMockCanvas();
        }
        return originalCreateElement(tagName);
      });

    const result = await compressImageForVision(blob);

    expect(result.type).toBe("image/jpeg");
    expect(mockCanvas.width).toBe(1707);
    expect(mockCanvas.height).toBe(960);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(fullBitmap, 0, 0, 1707, 960);
    expect(fullBitmap.close).toHaveBeenCalled();

    mockCreateElement.mockRestore();
  });

  it("falls back to Image when createImageBitmap is not available", async () => {
    const originalImage = global.Image;
    const originalCreateElement = document.createElement.bind(document);
    global.createImageBitmap = undefined as unknown as typeof createImageBitmap;

    global.Image = class MockImage {
      naturalWidth = 1920;
      naturalHeight = 1080;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        setTimeout(() => {
          this.onload?.();
        }, 0);
      }
    } as unknown as typeof Image;

    const mockCreateElement = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return createMockCanvas();
        }
        return originalCreateElement(tagName);
      });

    const blob = new Blob(["png"], { type: "image/png" });
    const result = await compressImageForVision(blob);

    expect(result.type).toBe("image/jpeg");
    expect(mockCanvas.width).toBe(1707);
    expect(mockCanvas.height).toBe(960);
    expect(mockCtx.imageSmoothingQuality).toBe("medium");

    mockCreateElement.mockRestore();
    global.Image = originalImage;
  });

  it("falls back to Image when createImageBitmap rejects", async () => {
    const originalImage = global.Image;
    const originalCreateElement = document.createElement.bind(document);
    global.createImageBitmap = vi.fn(async () => {
      throw new Error("not supported");
    }) as unknown as typeof createImageBitmap;

    global.Image = class MockImage {
      naturalWidth = 1920;
      naturalHeight = 1080;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        setTimeout(() => {
          this.onload?.();
        }, 0);
      }
    } as unknown as typeof Image;

    const mockCreateElement = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return createMockCanvas();
        }
        return originalCreateElement(tagName);
      });

    const blob = new Blob(["png"], { type: "image/png" });
    const result = await compressImageForVision(blob);

    expect(result.type).toBe("image/jpeg");
    expect(global.createImageBitmap).toHaveBeenCalled();

    mockCreateElement.mockRestore();
    global.Image = originalImage;
  });

  it("rejects when image load fails", async () => {
    const originalImage = global.Image;
    global.createImageBitmap = undefined as unknown as typeof createImageBitmap;

    global.Image = class MockImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        setTimeout(() => {
          this.onerror?.();
        }, 0);
      }
    } as unknown as typeof Image;

    const blob = new Blob(["png"], { type: "image/png" });
    await expect(compressImageForVision(blob)).rejects.toThrow("Failed to load image");

    global.Image = originalImage;
  });
});
