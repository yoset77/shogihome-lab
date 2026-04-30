import type express from "express";
import escapeHTML from "escape-html";

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
export const sendError = (res: express.Response, status: number, message: string) => {
  if (res.headersSent) {
    return;
  }
  res.status(status).type("text").send(escapeHTML(message));
};

export const errorHandler: express.ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  if (err instanceof HttpError) {
    sendError(res, err.status, err.message);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("Unhandled error:", err);
  sendError(res, 500, message);
};
