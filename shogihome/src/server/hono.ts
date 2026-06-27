import type { HttpBindings } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";
import { sendError } from "@/server/errors";

export type AppEnv = {
  Bindings: Partial<HttpBindings>;
};

export const DEFAULT_JSON_BODY_LIMIT = 100 * 1024;
export const LARGE_BODY_LIMIT = 10 * 1024 * 1024;

export const createBodyLimit = (maxSize: number): MiddlewareHandler<AppEnv> =>
  bodyLimit({
    maxSize,
    onError: (c) => sendError(c, 413, "Payload Too Large"),
  });
