import log4js from "log4js";
import { isTest } from "./proc/env.js";
import { LogLevel } from "@/common/log";

export interface Logger {
  debug(message: unknown, ...args: unknown[]): void;
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

let appLogger: Logger | undefined;

export function getAppLogger(): Logger {
  if (!appLogger) {
    appLogger = log4js
      .configure({
        appenders: { output: { type: isTest() ? "recording" : "stdout" } },
        categories: { default: { appenders: ["output"], level: LogLevel.INFO } },
      })
      .getLogger("app");
  }
  return appLogger;
}
