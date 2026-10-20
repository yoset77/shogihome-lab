import { describe, it, expect, vi, beforeEach } from "vitest";
import { webAPI } from "@/renderer/ipc/web";
import { toPng, toJpeg } from "html-to-image";
import {
  defaultAppSettings,
  FileQuickAction,
  PieceImageType,
  BoardImageType,
  PieceStandImageType,
  validateAppSettings,
} from "@/common/settings/app";
import { RecordFileFormat } from "@/common/file/record";

vi.mock("html-to-image", () => ({
  toPng: vi.fn(),
  toJpeg: vi.fn(),
}));

describe("renderer/ipc/web", () => {
  it("retrieves and validates server-side statistics using the complete query", async () => {
    const statistics = {
      total: 1,
      generatedAt: 100,
      strategies: [{ strategy: "角換わり", count: 1 }],
      players: [{ name: "A", black: 1, white: 1, total: 2 }],
      otherPlayers: { black: 0, white: 0, total: 0 },
      nextMoves: [{ move: "☗２五歩", count: 1 }],
    };
    const response = new Response(JSON.stringify(statistics), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const request = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", request);
    try {
      await expect(
        webAPI.getServerKifuStatistics({
          keyword: "Final",
          player1: "A",
          player2: "B",
          isStrictTurn: true,
          startDate: "2024",
          sfen: "startpos",
          strategy: "unclassified",
        }),
      ).resolves.toEqual(statistics);
      const url = new URL(request.mock.calls[0][0] as string);
      expect(url.pathname).toBe("/api/kifu/search/statistics");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        keyword: "Final",
        player1: "A",
        player2: "B",
        isStrictTurn: "true",
        startDate: "2024",
        sfen: "startpos",
        strategy: "unclassified",
      });
      request.mockResolvedValue(
        new Response(
          JSON.stringify({ ...statistics, nextMoves: [{ move: "☗２五歩", count: 2 }] }),
          {
            status: 200,
          },
        ),
      );
      await expect(webAPI.getServerKifuStatistics({})).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
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

  it.each([
    ["server://", "server://"],
    ["server://games", "server://games"],
    ["server://games///", "server://games"],
  ])(
    "preserves auto-save directory %s across browser save/load cycles",
    async (directory, expected) => {
      let json = JSON.stringify({ ...defaultAppSettings(), autoSaveDirectory: directory });
      for (let cycle = 0; cycle < 3; cycle++) {
        await webAPI.saveAppSettings(json);
        json = await webAPI.loadAppSettings();
        expect(JSON.parse(json).autoSaveDirectory).toBe(expected);
      }
    },
  );

  it("normalizes retired images at the browser storage boundary without resetting live settings", async () => {
    const stored = JSON.stringify({
      pieceImage: "custom-image",
      boardImage: "custom-image",
      pieceStandImage: "custom-image",
      defaultRecordFileFormat: RecordFileFormat.CSA,
      pieceVolume: 42,
      researchMultiPV: 3,
    });
    localStorage.setItem("appSetting", stored);
    const settings = JSON.parse(await webAPI.loadAppSettings());
    const defaults = defaultAppSettings();
    expect(settings).toMatchObject({
      pieceImage: defaults.pieceImage,
      boardImage: defaults.boardImage,
      pieceStandImage: defaults.pieceStandImage,
      defaultRecordFileFormat: RecordFileFormat.CSA,
      pieceVolume: 42,
      researchMultiPV: 3,
    });
    expect(validateAppSettings(settings)).toBeUndefined();
    expect(localStorage.getItem("appSetting")).toBe(stored);
  });

  it("retains bundled images when loading browser settings", async () => {
    const selected = {
      pieceImage: PieceImageType.FUTAMOJI,
      boardImage: BoardImageType.DARK,
      pieceStandImage: PieceStandImageType.DARK,
    };
    localStorage.setItem("appSetting", JSON.stringify(selected));
    expect(JSON.parse(await webAPI.loadAppSettings())).toMatchObject(selected);
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
