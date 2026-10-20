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
        autoSaveDirectory: path.join(mockUserDataPath, "Documents", "ShogiHome"),
      }),
    );
  });

  it("loads app settings from the server data directory", async () => {
    fs.writeFileSync(
      path.join(mockUserDataPath, "app_setting.json"),
      JSON.stringify({ autoSaveDirectory: "path/to/autoSaveDirectory" }),
      "utf8",
    );

    await expect(loadAppSettings()).resolves.toMatchObject({
      autoSaveDirectory: "path/to/autoSaveDirectory",
    });
  });
});
