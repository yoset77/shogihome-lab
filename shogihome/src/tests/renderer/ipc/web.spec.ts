import { describe, it, expect, vi, beforeEach } from "vitest";
import { webAPI } from "@/renderer/ipc/web";
import { toPng, toJpeg } from "html-to-image";

vi.mock("html-to-image", () => ({
  toPng: vi.fn(),
  toJpeg: vi.fn(),
}));

describe("renderer/ipc/web", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("exportCaptureAsPNG", async () => {
    const board = document.createElement("div");
    board.className = "export-board";
    document.body.appendChild(board);

    const mockClick = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const mockCreateElement = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "a") {
          return {
            click: mockClick,
            style: {},
            setAttribute: vi.fn(),
          } as unknown as HTMLAnchorElement;
        }
        return originalCreateElement(tagName);
      });

    vi.mocked(toPng).mockResolvedValue("data:image/png;base64,test");

    const rectJson = JSON.stringify({
      x: 0,
      y: 0,
      width: 800,
      height: 450,
      targetHeight: 900,
      targetWidth: 1200,
    });

    await webAPI.exportCaptureAsPNG(rectJson);

    expect(toPng).toHaveBeenCalledWith(
      board,
      expect.objectContaining({
        pixelRatio: 1,
        backgroundColor: "white",
        canvasWidth: 1200,
        canvasHeight: 900,
      }),
    );
    expect(mockClick).toHaveBeenCalled();

    mockCreateElement.mockRestore();
  });

  it("exportCaptureAsPNG falls back to rect size when targetHeight is missing", async () => {
    const board = document.createElement("div");
    board.className = "export-board";
    document.body.appendChild(board);

    const mockClick = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const mockCreateElement = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "a") {
          return {
            click: mockClick,
            style: {},
            setAttribute: vi.fn(),
          } as unknown as HTMLAnchorElement;
        }
        return originalCreateElement(tagName);
      });

    vi.mocked(toPng).mockResolvedValue("data:image/png;base64,test");

    const rectJson = JSON.stringify({ x: 0, y: 0, width: 800, height: 450 });

    await webAPI.exportCaptureAsPNG(rectJson);

    expect(toPng).toHaveBeenCalledWith(
      board,
      expect.objectContaining({
        pixelRatio: 1,
        backgroundColor: "white",
        canvasWidth: 800,
        canvasHeight: 450,
      }),
    );
    expect(mockClick).toHaveBeenCalled();

    mockCreateElement.mockRestore();
  });

  it("exportCaptureAsJPEG", async () => {
    const board = document.createElement("div");
    board.className = "export-board";
    document.body.appendChild(board);

    const mockClick = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const mockCreateElement = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "a") {
          return {
            click: mockClick,
            style: {},
            setAttribute: vi.fn(),
          } as unknown as HTMLAnchorElement;
        }
        return originalCreateElement(tagName);
      });

    vi.mocked(toJpeg).mockResolvedValue("data:image/jpeg;base64,test");

    const rectJson = JSON.stringify({
      x: 0,
      y: 0,
      width: 800,
      height: 450,
      targetHeight: 900,
      targetWidth: 1200,
    });

    await webAPI.exportCaptureAsJPEG(rectJson);

    expect(toJpeg).toHaveBeenCalledWith(
      board,
      expect.objectContaining({
        pixelRatio: 1,
        backgroundColor: "white",
        quality: 0.9,
        canvasWidth: 1200,
        canvasHeight: 900,
      }),
    );
    expect(mockClick).toHaveBeenCalled();

    mockCreateElement.mockRestore();
  });

  it("exportCaptureThrowsErrorIfElementNotFound", async () => {
    // .export-board element does not exist
    await expect(
      webAPI.exportCaptureAsPNG(JSON.stringify({ x: 0, y: 0, width: 800, height: 450 })),
    ).rejects.toThrow("Element not found: .export-board");
  });
});
