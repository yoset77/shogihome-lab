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
import {
  defaultGameSettings,
  validateGameSettings,
  type GameSettings,
} from "@/common/settings/game";
import { t } from "@/common/i18n";

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
    localStorage.removeItem("gameSetting");
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

  it.each([true, false, undefined])(
    "preserves the migration input when app settings are saved first with auto-save=%s",
    async (enableAutoSave) => {
      localStorage.setItem(
        "appSetting",
        JSON.stringify({ autoSaveDirectory: "server://games///", pieceVolume: 42 }),
      );
      if (enableAutoSave !== undefined) {
        const legacy: Partial<GameSettings> = { ...defaultGameSettings(), enableAutoSave };
        delete legacy.autoSaveDirectory;
        localStorage.setItem("gameSetting", JSON.stringify(legacy));
      }
      const storedGame = localStorage.getItem("gameSetting");
      for (let cycle = 0; cycle < 3; cycle++) {
        const app = JSON.parse(await webAPI.loadAppSettings());
        expect(app).not.toHaveProperty("autoSaveDirectory");
        await webAPI.saveAppSettings(JSON.stringify({ ...app, pieceVolume: 43 + cycle }));
        expect(JSON.parse(localStorage.getItem("appSetting")!)).toMatchObject({
          autoSaveDirectory: "server://games///",
          pieceVolume: 43 + cycle,
        });
        expect(JSON.parse(await webAPI.loadGameSettings())).toMatchObject({
          enableAutoSave: enableAutoSave ?? false,
          autoSaveDirectory: "server://games",
        });
        expect(localStorage.getItem("gameSetting")).toBe(storedGame);
      }
    },
  );

  it("allows replacing malformed app settings without adding a legacy destination", async () => {
    localStorage.setItem("appSetting", "invalid legacy JSON");
    const json = JSON.stringify(defaultAppSettings());
    await webAPI.saveAppSettings(json);
    expect(localStorage.getItem("appSetting")).toBe(json);
  });

  it.each(["", "server://new"])(
    "drops the legacy app destination once game destination %s is persisted",
    async (autoSaveDirectory) => {
      const settings = JSON.stringify({ ...defaultGameSettings(), autoSaveDirectory });
      localStorage.setItem("gameSetting", settings);
      localStorage.setItem(
        "appSetting",
        JSON.stringify({ autoSaveDirectory: "server://old", pieceVolume: 42 }),
      );
      const app = JSON.parse(await webAPI.loadAppSettings());
      await webAPI.saveAppSettings(
        JSON.stringify({ ...app, autoSaveDirectory: "server://stale", pieceVolume: 43 }),
      );
      const saved = JSON.parse(localStorage.getItem("appSetting")!);
      expect(saved).not.toHaveProperty("autoSaveDirectory");
      expect(saved.pieceVolume).toBe(43);
      expect(localStorage.getItem("gameSetting")).toBe(settings);
      expect(JSON.parse(await webAPI.loadGameSettings()).autoSaveDirectory).toBe(autoSaveDirectory);
    },
  );

  it("preserves the migration input when stored game settings are malformed", async () => {
    localStorage.setItem("gameSetting", "invalid game JSON");
    localStorage.setItem("appSetting", JSON.stringify({ autoSaveDirectory: "server://old" }));
    await webAPI.saveAppSettings(JSON.stringify(defaultAppSettings()));
    expect(JSON.parse(localStorage.getItem("appSetting")!).autoSaveDirectory).toBe("server://old");
  });

  it.each(["", "server://new"])(
    "retires the legacy destination after saving game destination %s without changing other app settings",
    async (autoSaveDirectory) => {
      const app = { pieceVolume: 42, futureSetting: { enabled: true } };
      localStorage.setItem(
        "appSetting",
        JSON.stringify({ ...app, autoSaveDirectory: "server://old" }),
      );
      const settings = JSON.stringify({ ...defaultGameSettings(), autoSaveDirectory });
      await webAPI.saveGameSettings(settings);
      expect(localStorage.getItem("gameSetting")).toBe(settings);
      expect(JSON.parse(localStorage.getItem("appSetting")!)).toEqual(app);
      await webAPI.saveAppSettings(await webAPI.loadAppSettings());
      expect(JSON.parse(localStorage.getItem("appSetting")!)).not.toHaveProperty(
        "autoSaveDirectory",
      );
      localStorage.removeItem("gameSetting");
      expect(JSON.parse(await webAPI.loadGameSettings())).toMatchObject({
        enableAutoSave: false,
        autoSaveDirectory: "",
      });
    },
  );

  it.each([undefined, null, 1])(
    "does not retire the legacy destination for an unmigrated game destination %s",
    async (autoSaveDirectory) => {
      const app = JSON.stringify({ autoSaveDirectory: "server://old" });
      localStorage.setItem("appSetting", app);
      await webAPI.saveGameSettings(
        JSON.stringify({ ...defaultGameSettings(), autoSaveDirectory }),
      );
      expect(localStorage.getItem("appSetting")).toBe(app);
    },
  );

  it("keeps the migration input when saving game settings fails", async () => {
    const app = JSON.stringify({ autoSaveDirectory: "server://old" });
    const game = JSON.stringify({ enableAutoSave: true });
    localStorage.setItem("appSetting", app);
    localStorage.setItem("gameSetting", game);
    const error = new DOMException("Storage is full", "QuotaExceededError");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw error;
    });
    try {
      await expect(webAPI.saveGameSettings(JSON.stringify(defaultGameSettings()))).rejects.toBe(
        error,
      );
      expect(localStorage.getItem("appSetting")).toBe(app);
      expect(localStorage.getItem("gameSetting")).toBe(game);
      expect(write).toHaveBeenCalledExactlyOnceWith("gameSetting", expect.any(String));
    } finally {
      write.mockRestore();
    }
  });

  it("keeps a successful game settings save when legacy cleanup fails and retries on app save", async () => {
    const app = JSON.stringify({ autoSaveDirectory: "server://old", pieceVolume: 42 });
    const game = JSON.stringify(defaultGameSettings());
    localStorage.setItem("appSetting", app);
    const setItem = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === "appSetting") throw new DOMException("Storage is full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    try {
      await expect(webAPI.saveGameSettings(game)).resolves.toBeUndefined();
      expect(write.mock.calls.map(([key]) => key)).toEqual(["gameSetting", "appSetting"]);
      expect(localStorage.getItem("gameSetting")).toBe(game);
      expect(localStorage.getItem("appSetting")).toBe(app);
    } finally {
      write.mockRestore();
    }
    await webAPI.saveAppSettings(await webAPI.loadAppSettings());
    const saved = JSON.parse(localStorage.getItem("appSetting")!);
    expect(saved).not.toHaveProperty("autoSaveDirectory");
    expect(saved.pieceVolume).toBe(42);
  });

  it.each(["", "server://games"])(
    "keeps new game auto-save disabled even with legacy app destination %s",
    async (autoSaveDirectory) => {
      localStorage.setItem("appSetting", JSON.stringify({ autoSaveDirectory }));
      expect(JSON.parse(await webAPI.loadGameSettings())).toMatchObject({
        enableAutoSave: false,
        autoSaveDirectory,
      });
      expect(localStorage.getItem("gameSetting")).toBeNull();
    },
  );

  it.each([
    [true, "server://games///", "server://games"],
    [false, "server://games", "server://games"],
    [true, "", "server://"],
    [false, "", ""],
    [true, "games/", "games"],
    [true, "server://../private", "server://../private"],
  ])(
    "migrates legacy auto-save=%s directory=%s without losing settings",
    async (enableAutoSave, oldDirectory, expected) => {
      const legacy: Partial<GameSettings> = {
        ...defaultGameSettings(),
        enableAutoSave,
        maxMoves: 123,
      };
      delete legacy.autoSaveDirectory;
      const storedGame = JSON.stringify(legacy);
      const storedApp = JSON.stringify({ autoSaveDirectory: oldDirectory, pieceVolume: 42 });
      localStorage.setItem("gameSetting", storedGame);
      localStorage.setItem("appSetting", storedApp);
      for (let cycle = 0; cycle < 3; cycle++) {
        const loaded = await webAPI.loadGameSettings();
        expect(JSON.parse(loaded)).toMatchObject({
          enableAutoSave,
          autoSaveDirectory: expected,
          maxMoves: 123,
        });
        expect(localStorage.getItem("gameSetting")).toBe(cycle === 0 ? storedGame : loaded);
        if (cycle === 0) expect(localStorage.getItem("appSetting")).toBe(storedApp);
        await webAPI.saveGameSettings(loaded);
        expect(JSON.parse(localStorage.getItem("appSetting")!)).toEqual({ pieceVolume: 42 });
      }
    },
  );

  it.each(["", "server://", "server://new", "server://new///"])(
    "never overwrites the explicit game destination %s with the legacy value",
    async (autoSaveDirectory) => {
      const settings = { ...defaultGameSettings(), enableAutoSave: true, autoSaveDirectory };
      localStorage.setItem("appSetting", "invalid legacy JSON");
      await webAPI.saveGameSettings(JSON.stringify(settings));
      for (let cycle = 0; cycle < 3; cycle++) {
        const loaded = await webAPI.loadGameSettings();
        expect(JSON.parse(loaded)).toMatchObject({
          enableAutoSave: true,
          autoSaveDirectory:
            autoSaveDirectory === "server://new///" ? "server://new" : autoSaveDirectory,
        });
        await webAPI.saveGameSettings(loaded);
      }
    },
  );

  it.each([1, false, [], {}, null].map((autoSaveDirectory) => ({ autoSaveDirectory })))(
    "clears a non-string stored game destination $autoSaveDirectory instead of using the legacy destination",
    async ({ autoSaveDirectory }) => {
      localStorage.setItem("appSetting", "invalid legacy JSON");
      const stored = JSON.stringify({
        ...defaultGameSettings(),
        enableAutoSave: true,
        autoSaveDirectory,
      });
      localStorage.setItem("gameSetting", stored);
      const loaded = await webAPI.loadGameSettings();
      const settings = JSON.parse(loaded);
      expect(settings).toMatchObject({ enableAutoSave: true, autoSaveDirectory: "" });
      expect(validateGameSettings(settings)?.message).toBe(t.autoSaveDirectoryNotSet);
      expect(localStorage.getItem("gameSetting")).toBe(stored);
      await webAPI.saveGameSettings(loaded);
      expect(JSON.parse(await webAPI.loadGameSettings())).toEqual(settings);
    },
  );

  it.each([1, false, [], {}, null].map((autoSaveDirectory) => ({ autoSaveDirectory })))(
    "clears a non-string legacy app destination $autoSaveDirectory rather than selecting the server root",
    async ({ autoSaveDirectory }) => {
      localStorage.setItem("appSetting", JSON.stringify({ autoSaveDirectory }));
      localStorage.setItem("gameSetting", JSON.stringify({ enableAutoSave: true, maxMoves: 123 }));
      const storedGame = localStorage.getItem("gameSetting");
      for (let cycle = 0; cycle < 2; cycle++) {
        const app = await webAPI.loadAppSettings();
        expect(JSON.parse(app)).not.toHaveProperty("autoSaveDirectory");
        const settings = JSON.parse(await webAPI.loadGameSettings());
        expect(settings).toMatchObject({
          enableAutoSave: true,
          autoSaveDirectory: "",
          maxMoves: 123,
        });
        expect(validateGameSettings(settings)?.message).toBe(t.autoSaveDirectoryNotSet);
        await webAPI.saveAppSettings(app);
        expect(localStorage.getItem("gameSetting")).toBe(storedGame);
      }
    },
  );

  it("preserves the legacy enabled default when an old saved game omitted the flag", async () => {
    localStorage.setItem("gameSetting", JSON.stringify({ maxMoves: 123 }));
    expect(JSON.parse(await webAPI.loadGameSettings())).toMatchObject({
      enableAutoSave: true,
      autoSaveDirectory: "server://",
    });
  });

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
