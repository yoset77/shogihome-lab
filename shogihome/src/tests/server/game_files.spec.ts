// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Record } from "tsshogi";
import { gameRequest } from "./helpers/game";
import { saveGameRecord, loadGamePositions } from "@/server/game/files";
import { importRecordFromBuffer, RecordFileFormat } from "@/common/file/record";
import { defaultAppSettings, normalizeAppSettings } from "@/common/settings/app";

const config = vi.hoisted(() => ({ directory: "" }));
vi.mock("@/server/config", async (original) => ({
  ...(await original<typeof import("@/server/config")>()),
  get KIFU_DIR() {
    return config.directory;
  },
}));
describe("server game files", () => {
  beforeEach(async () => {
    config.directory = await fs.mkdtemp(path.join(os.tmpdir(), "game-files-"));
  });
  afterEach(async () => {
    if (config.directory) await fs.rm(config.directory, { recursive: true, force: true });
    config.directory = "";
  });
  it("saves frozen records atomically without overwriting colliding filenames", async () => {
    const request = gameRequest();
    request.options.save.template = "match";
    const first = await saveGameRecord(request.source, request.options.save, "one");
    const second = await saveGameRecord(request.source, request.options.save, "two");
    expect(first).toBe("match.kifu");
    expect(second).toBe("match_two_1.kifu");
    const contents = await fs.readFile(path.join(config.directory, first));
    expect(importRecordFromBuffer(contents, RecordFileFormat.KIFU)).toBeInstanceOf(Record);
    expect((await fs.readdir(config.directory)).sort()).toEqual([first, second].sort());
  });
  it("saves to the server root after normalizing app settings", async () => {
    const settings = normalizeAppSettings({
      ...defaultAppSettings(),
      autoSaveDirectory: "server://",
    });
    const request = gameRequest();
    request.options.save.directory = settings.autoSaveDirectory;
    request.options.save.template = "root";
    expect(await saveGameRecord(request.source, request.options.save, "test")).toBe("root.kifu");
    expect(await fs.readdir(config.directory)).toEqual(["root.kifu"]);
  });
  it("rejects traversal, symlink and reserved writer paths", async () => {
    const request = gameRequest();
    await expect(
      saveGameRecord(request.source, { ...request.options.save, directory: "../" }, "test"),
    ).rejects.toThrow();
    await fs.symlink(os.tmpdir(), path.join(config.directory, "linked"));
    await expect(
      saveGameRecord(request.source, { ...request.options.save, directory: "linked" }, "test"),
    ).rejects.toThrow();
    await fs.mkdir(path.join(config.directory, "hidden.lock"));
    await expect(
      saveGameRecord(request.source, { ...request.options.save, directory: "hidden.lock" }, "test"),
    ).rejects.toThrow();
  });
  it("loads only validated server SFEN files and strips empty/comment lines", async () => {
    await fs.writeFile(
      path.join(config.directory, "positions.sfen"),
      "# positions\n\nposition startpos\n",
    );
    expect(await loadGamePositions("server://positions.sfen")).toEqual(["position startpos"]);
    await expect(loadGamePositions("server://../positions.sfen")).rejects.toThrow();
    await expect(loadGamePositions("positions.sfen")).rejects.toThrow();
    await fs.writeFile(path.join(config.directory, "wrong.kifu"), "position startpos");
    await expect(loadGamePositions("server://wrong.kifu")).rejects.toThrow();
  });
});
