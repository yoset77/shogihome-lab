import path from "node:path";
import child_process from "node:child_process";
import log4js from "log4js";
import { getDateTimeString } from "@/common/helpers/datetime.js";
import { isTest } from "./proc/env.js";
import { LogLevel, LogType } from "@/common/log.js";
import { getUserDataPath } from "./proc/path.js";

function getLogPath(name: string): string {
  return path.join(getUserDataPath(), "logs", name);
}

export function openLogsDirectory(): Promise<void> {
  return Promise.resolve(); // Not supported in server mode
}

const datetime = getDateTimeString().replaceAll(" ", "_").replaceAll("/", "").replaceAll(":", "");

const config: log4js.Configuration = {
  appenders: {
    stdout: { type: "stdout" },
    recording: { type: "recording" },
  },
  categories: {
    default: { appenders: ["stdout"], level: "info" },
  },
};

function getFilePath(type: LogType): string {
  switch (type) {
    case LogType.APP:
      return getLogPath(`app-${datetime}.log`);
    case LogType.USI:
      return getLogPath(`usi-${datetime}.log`);
    case LogType.CSA:
      return getLogPath(`csa-${datetime}.log`);
  }
}

const defaultAppender = isTest() ? "recording" : "stdout";

const appenders = {
  [LogType.APP]: [defaultAppender] as string[],
  [LogType.USI]: [defaultAppender] as string[],
  [LogType.CSA]: [defaultAppender] as string[],
};

const levels = {
  [LogType.APP]: LogLevel.INFO,
  [LogType.USI]: LogLevel.INFO,
  [LogType.CSA]: LogLevel.INFO,
};

export type LogDestination = "file" | "stdout" | "recording";

export function setLogDestinations(
  type: LogType,
  destinations: LogDestination[],
  level: LogLevel,
): void {
  appenders[type] = destinations.map((d) => (d === "file" ? type : d));
  levels[type] = level;
}

export interface Logger {
  debug(message: unknown, ...args: unknown[]): void;
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

const loggers: { [key: string]: Logger } = {};

function getLogger(type: LogType): Logger {
  if (loggers[type]) {
    return loggers[type];
  }
  if (!config.appenders[type]) {
    config.appenders[type] = { type: "file", filename: getFilePath(type) };
    config.categories[type] = {
      appenders: appenders[type],
      level: levels[type],
    };
  }
  const logger = log4js.configure(config).getLogger(type);
  loggers[type] = logger;
  return logger;
}

export function getAppLogger(): Logger {
  return getLogger(LogType.APP);
}

export function getUSILogger(): Logger {
  return getLogger(LogType.USI);
}

export function getCSALogger(): Logger {
  return getLogger(LogType.CSA);
}

export function shutdownLoggers(): void {
  log4js.shutdown((e) => {
    console.error("failed to shutdown loggers:", e);
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function openLogFile(_logType: LogType): Promise<void> {
  return Promise.resolve();
}

export function getTailCommand(logType: LogType): string {
  const filePath = getFilePath(logType);
  switch (process.platform) {
    case "win32":
      return `Get-Content -Path "${filePath}" -Wait -Tail 10`;
    default:
      return `tail -f "${filePath}"`;
  }
}

export function tailLogFile(logType: LogType): void {
  const escapedCommand = getTailCommand(logType).replaceAll('"', '\\"');
  switch (process.platform) {
    case "win32":
      child_process.spawn("powershell.exe", [
        "-Command",
        `start-process powershell '-NoExit','-Command "${escapedCommand}"'`,
      ]);
      break;
    case "darwin":
      child_process.spawn("osascript", [
        "-e",
        `tell app "Terminal" to do script "${escapedCommand}"`,
        "-e",
        `tell app "Terminal" to activate`,
      ]);
      break;
  }
}
