import type { Context } from "hono";
import { t } from "@/common/i18n";
import { HttpError } from "@/server/errors";
import type { AppEnv } from "@/server/hono";

export function parseJsonObject(
  value: unknown,
  message = t.serverInvalidJsonBody,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, message);
  }
  return value as Record<string, unknown>;
}

export async function readJsonBody(
  c: Context<AppEnv>,
  message = t.serverInvalidJsonBody,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await c.req.json<unknown>();
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400, message);
    throw error;
  }
  return parseJsonObject(value, message);
}
