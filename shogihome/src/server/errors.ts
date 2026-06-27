import escapeHTML from "escape-html";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

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
  if (err instanceof HttpError) {
    return sendError(c, err.status as ContentfulStatusCode, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("Unhandled error:", err);
  return sendError(c, 500, message);
};
