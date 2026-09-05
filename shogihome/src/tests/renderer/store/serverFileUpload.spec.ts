import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiResponseError } from "@/renderer/api/client";

const apiMock = vi.hoisted(() => ({
  listServerDirectories: vi.fn(),
  uploadServerFile: vi.fn(),
}));
const busyMock = vi.hoisted(() => ({ retain: vi.fn(), release: vi.fn() }));

vi.mock("@/renderer/ipc/api", () => ({ default: apiMock }));
vi.mock("@/renderer/store/busy", () => ({ useBusyState: () => busyMock }));

import { listUploadDirectories, uploadServerFiles } from "@/renderer/store/serverFileUpload";

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

    const result = await uploadServerFiles(files, "archive");

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

    const result = await uploadServerFiles(files, "");

    expect(result.conflicts).toEqual([files[0]]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("b.db");
    expect(busyMock.release).toHaveBeenCalledOnce();
  });

  it("treats conflicts during overwrite as errors", async () => {
    const file = new File(["a"], "a.kif");
    apiMock.uploadServerFile.mockRejectedValue(new ApiResponseError(409, "conflict"));

    const result = await uploadServerFiles([file], "", true);

    expect(result.conflicts).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
});
