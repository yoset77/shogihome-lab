import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getLocalIpAddresses } from "@/server/helpers/ip";
import { dataDir } from "@/node/proc/path";

const hasRuntimeAssets = (basePath: string): boolean =>
  fs.existsSync(path.join(basePath, "docs", "webapp")) ||
  fs.existsSync(path.join(basePath, "package.json"));

export const resolveBasePath = (
  moduleUrl: string,
  cwd: string,
  execPath: string,
  explicitBasePath = process.env.SHOGIHOME_BASE_PATH,
) => {
  if (explicitBasePath) {
    return path.resolve(explicitBasePath);
  }
  if (path.basename(execPath) === "shogihome-server.exe") {
    return path.dirname(execPath);
  }
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [cwd, path.resolve(moduleDir, "../.."), moduleDir];
  const basePath = candidates.find(hasRuntimeAssets);
  return basePath ?? path.resolve(moduleDir, "../..");
};

export const getBasePath = () => {
  return resolveBasePath(import.meta.url, process.cwd(), process.execPath);
};

const envPath = path.join(getBasePath(), ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export const parseIntegerConfigValue = (
  raw: string | undefined,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number => {
  if (!raw) return defaultValue;
  const value = parseInt(raw, 10);
  if (isNaN(value) || value < min || value > max) {
    console.error(`Invalid ${name}: "${raw}". Using default (${defaultValue}).`);
    return defaultValue;
  }
  return value;
};

const parseIntegerEnv = (name: string, defaultValue: number, min: number, max: number): number =>
  parseIntegerConfigValue(process.env[name], name, defaultValue, min, max);

export const parseAllowedFetchDomains = (raw: string | undefined): Set<string> =>
  new Set(
    (raw || "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d !== ""),
  );

export const PORT = parseIntegerEnv("PORT", 8140, 1, 65535);
export const ENGINE_STOP_TIMEOUT_MS = parseIntegerEnv(
  "ENGINE_STOP_TIMEOUT_MS",
  10000,
  1000,
  600000,
);

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
export { dataDir };
export const KIFU_DIR = process.env.KIFU_DIR
  ? path.resolve(getBasePath(), process.env.KIFU_DIR)
  : null;

export const ONTHEFLY_THRESHOLD_MB = (() => {
  const raw = process.env.ONTHEFLY_THRESHOLD_MB;
  if (!raw) return 128;
  const val = parseInt(raw, 10);
  if (isNaN(val) || val <= 0) {
    console.error(`Invalid ONTHEFLY_THRESHOLD_MB: "${raw}". Using default (128 MB).`);
    return 128;
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
export const REMOTE_ENGINE_PORT = parseIntegerEnv("REMOTE_ENGINE_PORT", 4082, 1, 65535);
export const CONNECTION_PROTECTION_TIMEOUT =
  parseIntegerEnv("ENGINE_CONNECTION_PROTECTION_TIMEOUT", 60, 1, 3600) * 1000;
export const ALLOWED_FETCH_DOMAINS = parseAllowedFetchDomains(process.env.ALLOWED_FETCH_DOMAINS);
export const BIND_ADDRESS = process.env.BIND_ADDRESS || "127.0.0.1";
