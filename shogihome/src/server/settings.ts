import fs from "node:fs";
import path from "node:path";
import { AppSettings, defaultAppSettings, normalizeAppSettings } from "@/common/settings/app";
import { getUserDataPath } from "@/node/proc/path";

function getUserDir() {
  return getUserDataPath();
}

function getDocDir() {
  return path.join(getUserDir(), "Documents", "ShogiHome");
}

function getAppSettingsPath() {
  return path.join(getUserDir(), "app_setting.json");
}

const defaultReturnCode = process.platform === "win32" ? "\r\n" : "\n";

function getDefaultAppSettings(): AppSettings {
  return defaultAppSettings({
    returnCode: defaultReturnCode,
    autoSaveDirectory: getDocDir(),
  });
}

function loadAppSettingsFromMemory(json: string): AppSettings {
  return normalizeAppSettings(JSON.parse(json), {
    returnCode: defaultReturnCode,
    autoSaveDirectory: getDocDir(),
  });
}

export async function loadAppSettings(): Promise<AppSettings> {
  const p = getAppSettingsPath();
  try {
    return loadAppSettingsFromMemory(await fs.promises.readFile(p, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultAppSettings();
    }
    throw e;
  }
}
