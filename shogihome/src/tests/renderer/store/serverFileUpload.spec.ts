import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiResponseError } from "@/renderer/api/client";

const apiMock = vi.hoisted(() => ({
  listServerDirectories: vi.fn(),
  createServerDirectory: vi.fn(),
  uploadServerFile: vi.fn(),
}));
const busyMock = vi.hoisted(() => ({ retain: vi.fn(), release: vi.fn() }));

vi.mock("@/renderer/ipc/api", () => ({ default: apiMock }));
vi.mock("@/renderer/store/busy", () => ({ useBusyState: () => busyMock }));

import {
  createUploadDirectory,
  createUploadItem,
  getUploadFileName,
  listUploadDirectories,
  uploadServerFiles,
} from "@/renderer/store/serverFileUpload";

describe("store/serverFileUpload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists upload destination directories", async () => {
    apiMock.listServerDirectories.mockResolvedValue({ path: "books", directories: [] });

    await expect(listUploadDirectories("books")).resolves.toEqual({
      path: "books",
      directories: [],
    });
    expect(apiMock.listServerDirectories).toHaveBeenCalledWith("books");
  });

  it("uploads files sequentially to the selected directory", async () => {
    const files = [new File(["a"], "a.kif"), new File(["b"], "b.db")];
    apiMock.uploadServerFile
      .mockResolvedValueOnce({ path: "archive/a.kif" })
      .mockResolvedValueOnce({ path: "archive/b.db" });

    const result = await uploadServerFiles(files.map(createUploadItem), "archive");

    expect(apiMock.uploadServerFile.mock.calls).toEqual([
      ["archive/a.kif", files[0], false],
      ["archive/b.db", files[1], false],
    ]);
    expect(result.uploaded).toHaveLength(2);
    expect(result.conflicts).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(busyMock.retain).toHaveBeenCalledOnce();
    expect(busyMock.release).toHaveBeenCalledOnce();
  });

  it("separates conflicts from other failures", async () => {
    const files = [new File(["a"], "a.kif"), new File(["b"], "b.db")];
    apiMock.uploadServerFile
      .mockRejectedValueOnce(new ApiResponseError(409, "file already exists"))
      .mockRejectedValueOnce(new ApiResponseError(413, "Payload Too Large"));

    const result = await uploadServerFiles(files.map(createUploadItem), "");

    expect(result.conflicts).toEqual([createUploadItem(files[0])]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("b.db");
    expect(busyMock.release).toHaveBeenCalledOnce();
  });

  it("treats conflicts during overwrite as errors", async () => {
    const file = new File(["a"], "a.kif");
    apiMock.uploadServerFile.mockRejectedValue(new ApiResponseError(409, "conflict"));

    const result = await uploadServerFiles([createUploadItem(file)], "", true);

    expect(result.conflicts).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("keeps the original extension when editing the save name", () => {
    const item = createUploadItem(new File(["kifu"], "original.game.KIF"));
    expect(item.baseName).toBe("original.game");
    item.baseName = "renamed";
    expect(getUploadFileName(item)).toBe("renamed.KIF");
    expect(item.file.name).toBe("original.game.KIF");
  });

  it("uploads equal source names under distinct save names", async () => {
    const items = [new File(["a"], "game.kif"), new File(["b"], "game.kif")].map(createUploadItem);
    items[1].baseName = "second";
    apiMock.uploadServerFile.mockResolvedValue({ kind: "kifu" });

    await uploadServerFiles(items, "games");

    expect(apiMock.uploadServerFile.mock.calls).toEqual([
      ["games/game.kif", items[0].file, false],
      ["games/second.kif", items[1].file, false],
    ]);
  });

  it("preserves the renamed destination in conflicts and retries", async () => {
    const item = createUploadItem(new File(["a"], "original.kif"));
    item.baseName = "renamed";
    apiMock.uploadServerFile.mockRejectedValueOnce(new ApiResponseError(409, "conflict"));
    const result = await uploadServerFiles([item], "games");
    item.baseName = "edited-after-upload";
    apiMock.uploadServerFile.mockResolvedValueOnce({ path: "games/renamed.kif" });

    await uploadServerFiles(result.conflicts, "games", true);

    expect(apiMock.uploadServerFile).toHaveBeenLastCalledWith("games/renamed.kif", item.file, true);
  });

  it.each(["", "../escape", "nested/name", ".hidden", "CON", "x".repeat(250)])(
    "rejects invalid save name %j before sending files",
    async (name) => {
      const item = createUploadItem(new File(["a"], "game.kif"));
      item.baseName = name;
      await expect(uploadServerFiles([item], "")).rejects.toThrow();
      expect(apiMock.uploadServerFile).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate save names case-insensitively before uploading", async () => {
    const items = [new File(["a"], "first.kif"), new File(["b"], "second.kif")].map(
      createUploadItem,
    );
    items[0].baseName = "same";
    items[1].baseName = "SAME";

    await expect(uploadServerFiles(items, "")).rejects.toThrow();
    expect(apiMock.uploadServerFile).not.toHaveBeenCalled();
  });

  it("rejects unsupported extensions before uploading", async () => {
    const item = createUploadItem(new File(["a"], "notes.txt"));
    await expect(uploadServerFiles([item], "")).rejects.toThrow();
    expect(apiMock.uploadServerFile).not.toHaveBeenCalled();
  });

  it("does not add an extension to an unsupported source by editing its base name", async () => {
    const item = createUploadItem(new File(["a"], "notes"));
    item.baseName = "game.kif";
    await expect(uploadServerFiles([item], "")).rejects.toThrow();
    expect(apiMock.uploadServerFile).not.toHaveBeenCalled();
  });

  it("creates a directory under the selected parent", async () => {
    apiMock.createServerDirectory.mockResolvedValue({ name: "new", path: "games/new" });
    await expect(createUploadDirectory("games", "new")).resolves.toEqual({
      name: "new",
      path: "games/new",
    });
    expect(apiMock.createServerDirectory).toHaveBeenCalledWith("games", "new");
  });

  it("rejects invalid directory names without sending a request", () => {
    expect(() => createUploadDirectory("", "../escape")).toThrow();
    expect(apiMock.createServerDirectory).not.toHaveBeenCalled();
  });
});
