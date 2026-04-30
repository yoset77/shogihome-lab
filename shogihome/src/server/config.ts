import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getLocalIpAddresses } from "@/background/helpers/ip";

export const getBasePath = () => {
  // SEA (Single Executable Application) environment check
  if (path.basename(process.execPath) === "shogihome-server.exe") {
    return path.dirname(process.execPath);
  }
  const __filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(__filename), "../..");
};

const envPath = path.join(getBasePath(), ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export const PORT = parseInt(process.env.PORT || "8140", 10);

let engineStopTimeout = parseInt(process.env.ENGINE_STOP_TIMEOUT_MS || "10000", 10);
if (isNaN(engineStopTimeout) || engineStopTimeout <= 0) {
  engineStopTimeout = 10000;
}
export const ENGINE_STOP_TIMEOUT_MS = Math.min(Math.max(engineStopTimeout, 1000), 600000);

const DISABLE_AUTO_ALLOWED_ORIGINS = process.env.DISABLE_AUTO_ALLOWED_ORIGINS === "true";

const rawAllowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter((origin) => origin.length > 0);

export const ALLOWED_ORIGINS: string[] = [];
export const ALLOWED_HOSTS = new Set<string>();

if (DISABLE_AUTO_ALLOWED_ORIGINS) {
  rawAllowedOrigins.forEach((origin) => ALLOWED_ORIGINS.push(origin));
} else {
  const defaults = [...rawAllowedOrigins, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];

  defaults.forEach((origin) => {
    if (!ALLOWED_ORIGINS.includes(origin)) ALLOWED_ORIGINS.push(origin);
  });

  const localIps = getLocalIpAddresses();
  console.log("Auto-detected local IPs:", localIps);

  localIps.forEach((ip) => {
    const origin = `http://${ip}:${PORT}`;
    if (!ALLOWED_ORIGINS.includes(origin)) {
      ALLOWED_ORIGINS.push(origin);
    }
  });
}

ALLOWED_ORIGINS.forEach((origin) => {
  try {
    const url = new URL(origin);
    ALLOWED_HOSTS.add(url.host);
  } catch {
    // ignore invalid URLs
  }
});

console.log("Allowed Origins:", ALLOWED_ORIGINS);

export const shogiHomePath = path.join(getBasePath(), "docs", "webapp");
export const dataDir = path.join(getBasePath(), "data");
export const KIFU_DIR = process.env.KIFU_DIR
  ? path.resolve(getBasePath(), process.env.KIFU_DIR)
  : null;

export const ONTHEFLY_THRESHOLD_MB = (() => {
  const raw = process.env.ONTHEFLY_THRESHOLD_MB;
  if (!raw) return 256;
  const val = parseInt(raw, 10);
  if (isNaN(val) || val <= 0) {
    console.error(`Invalid ONTHEFLY_THRESHOLD_MB: "${raw}". Using default (256 MB).`);
    return 256;
  }
  return val;
})();

export const ANALYSIS_DB_MIN_DEPTH = (() => {
  const raw = process.env.ANALYSIS_DB_MIN_DEPTH;
  if (!raw) return 10;
  const val = parseInt(raw, 10);
  if (isNaN(val) || val < 0) {
    console.error(`Invalid ANALYSIS_DB_MIN_DEPTH: "${raw}". Using default (10).`);
    return 10;
  }
  return val;
})();

export const REMOTE_ENGINE_HOST = process.env.REMOTE_ENGINE_HOST || "localhost";
export const REMOTE_ENGINE_PORT = parseInt(process.env.REMOTE_ENGINE_PORT || "4082", 10);
export const CONNECTION_PROTECTION_TIMEOUT =
  parseInt(process.env.ENGINE_CONNECTION_PROTECTION_TIMEOUT || "60", 10) * 1000;
export const BIND_ADDRESS = process.env.BIND_ADDRESS || "127.0.0.1";
