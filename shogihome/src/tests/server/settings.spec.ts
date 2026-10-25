import path from "node:path";
import fs from "node:fs";
import { getUserDataPath } from "@/node/proc/path";
import { loadAppSettings } from "@/server/settings";
import { defaultAppSettings } from "@/common/settings/app";
import { getTempPathForTesting } from "@/tests/helpers/temp";

vi.mock("@/node/proc/path.js");

const mockUserDataPath = path.join(getTempPathForTesting(), "userData");

vi.mocked(getUserDataPath).mockReturnValue(mockUserDataPath);

describe("server/settings", () => {
  beforeEach(() => {
    fs.rmSync(mockUserDataPath, { recursive: true, force: true });
    fs.mkdirSync(mockUserDataPath, { recursive: true });
  });

  it("loads default app settings for server-side book imports", async () => {
    await expect(loadAppSettings()).resolves.toEqual(
      defaultAppSettings({
        returnCode: process.platform === "win32" ? "\r\n" : "\n",
      }),
    );
  });

  it.each(["path/to/autoSaveDirectory", 1, null])(
    "loads current server app settings without the legacy destination %j",
    async (autoSaveDirectory) => {
      const file = path.join(mockUserDataPath, "app_setting.json");
      const stored = JSON.stringify({ autoSaveDirectory, pieceVolume: 42 });
      fs.writeFileSync(file, stored, "utf8");

      const settings = await loadAppSettings();
      expect(settings.pieceVolume).toBe(42);
      expect(settings).not.toHaveProperty("autoSaveDirectory");
      expect(fs.readFileSync(file, "utf8")).toBe(stored);
    },
  );
});
