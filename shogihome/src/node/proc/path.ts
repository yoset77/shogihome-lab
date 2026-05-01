import path from "node:path";
import process from "node:process";

function getDataRootPath(): string {
  if (process.env.SHOGIHOME_BASE_PATH) {
    return path.resolve(process.env.SHOGIHOME_BASE_PATH);
  }
  if (["shogihome-server.exe", "shogihome-server"].includes(path.basename(process.execPath))) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

export const dataDir = path.join(getDataRootPath(), "data");

export function getUserDataPath(): string {
  return dataDir;
}

export const electronLicensePath = ""; // Not used in Web/LAN version
export const chromiumLicensePath = ""; // Not used in Web/LAN version
