import escapeHTML from "escape-html";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { t } from "@/common/i18n";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// Send safe text/plain responses to avoid reflected XSS in error paths.
export const sendError = (c: Context, status: ContentfulStatusCode, message: string) =>
  c.text(escapeHTML(message), status);

export const handleError = (err: unknown, c: Context) => {
  if (err instanceof HttpError || err instanceof HTTPException) {
    return sendError(c, err.status as ContentfulStatusCode, err.message);
  }
  console.error("Unhandled error:", err);
  return sendError(c, 500, t.serverInternalError);
};

export const isMissingFile = (err: unknown): boolean =>
  err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
