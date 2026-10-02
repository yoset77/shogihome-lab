import { describe, it, expect, vi, beforeEach } from "vitest";
import { webAPI } from "@/renderer/ipc/web";
import { toPng, toJpeg } from "html-to-image";
import { FileQuickAction } from "@/common/settings/app";

vi.mock("html-to-image", () => ({
  toPng: vi.fn(),
  toJpeg: vi.fn(),
}));

describe("renderer/ipc/web", () => {
  it.each(["book", "record"])(
    "returns cancellation without retrying a %s overwrite",
    async (kind) => {
      const request = vi.fn().mockResolvedValue(new Response("exists", { status: 409 }));
      vi.stubGlobal("fetch", request);
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      try {
        const result =
          kind === "book"
            ? webAPI.saveBook("server://other.db", "session-1")
            : webAPI.saveServerKifu("other.kif", new Uint8Array([1]));
        await expect(result).resolves.toBe(false);
        expect(confirm).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledOnce();
      } finally {
        confirm.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    localStorage.removeItem("appSetting");
  });

  it("retries a conflicting record save only after confirming the destination", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("exists", { status: 409 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", request);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await webAPI.saveServerKifu("existing.kif", new Uint8Array([1, 2]));
      expect(confirm).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(2);
      expect(new URL(request.mock.calls[0][0] as string).searchParams.get("overwrite")).toBe(
        "false",
      );
      expect(new URL(request.mock.calls[1][0] as string).searchParams.get("overwrite")).toBe(
        "true",
      );
    } finally {
      confirm.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("overwrites the currently open record without asking again", async () => {
    const request = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", request);
    const confirm = vi.spyOn(window, "confirm");
    try {
      await webAPI.saveServerKifu("current.kif", new Uint8Array([1]), true);
      expect(confirm).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();
      expect(new URL(request.mock.calls[0][0] as string).searchParams.get("overwrite")).toBe(
        "true",
      );
    } finally {
      confirm.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("overwrites the currently open book without asking again", async () => {
    const request = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", request);
    const confirm = vi.spyOn(window, "confirm");
    try {
      await webAPI.saveBook("server://current.db", "session-1", true);
      expect(confirm).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();
      expect(new URL(request.mock.calls[0][0] as string).searchParams.get("overwrite")).toBe(
        "true",
      );
    } finally {
      confirm.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("still confirms an existing destination when saving a book under a different name", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("exists", { status: 409 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", request);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await webAPI.saveBook("server://other.db", "session-1");
      expect(confirm).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        request.mock.calls.map(([url]) => new URL(url as string).searchParams.get("overwrite")),
      ).toEqual(["false", "true"]);
    } finally {
      confirm.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("loads old and unsupported quick action settings safely", async () => {
    localStorage.setItem("appSetting", JSON.stringify({ language: "en" }));
    expect(JSON.parse(await webAPI.loadAppSettings()).fileQuickAction).toBe(FileQuickAction.PUZZLE);

    localStorage.setItem("appSetting", JSON.stringify({ fileQuickAction: "unknown" }));
    expect(JSON.parse(await webAPI.loadAppSettings()).fileQuickAction).toBe(FileQuickAction.PUZZLE);

    localStorage.setItem(
      "appSetting",
      JSON.stringify({ fileQuickAction: FileQuickAction.LOAD_FROM_SERVER }),
    );
    expect(JSON.parse(await webAPI.loadAppSettings()).fileQuickAction).toBe(
      FileQuickAction.LOAD_FROM_SERVER,
    );
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
