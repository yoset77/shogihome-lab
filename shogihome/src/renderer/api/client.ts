import { hc } from "hono/client";
import type { AppType } from "@/common/api/rpc";

const REQUEST_TIMEOUT_HEADER = "X-ShogiHome-Request-Timeout-Ms";
const BOOK_SESSION_HEADER = "X-Book-Session-Id";
export const DEFAULT_API_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MESSAGE = "Request timeout";

export class RequestTimeoutError extends Error {
  constructor() {
    super(REQUEST_TIMEOUT_MESSAGE);
    this.name = "RequestTimeoutError";
  }
}

export function isRequestTimeoutError(error: unknown): boolean {
  return (
    error instanceof RequestTimeoutError ||
    (error instanceof Error && error.message === REQUEST_TIMEOUT_MESSAGE)
  );
}

type ApiClientOptions = {
  timeoutMs?: number;
  getBookSessionId?: () => string | undefined;
};

type ApiRequestOptions = {
  timeoutMs?: number;
  bookSessionId?: string;
  headers?: Record<string, string>;
  init?: RequestInit;
};

export const createApiRequestOptions = (options: ApiRequestOptions = {}) => {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.timeoutMs !== undefined) {
    headers[REQUEST_TIMEOUT_HEADER] = String(options.timeoutMs);
  }
  if (options.bookSessionId) {
    headers[BOOK_SESSION_HEADER] = options.bookSessionId;
  }
  return {
    headers,
    init: options.init,
  };
};

export const createHonoApiClient = (options: ApiClientOptions = {}) => {
  return hc<AppType>(location.origin, {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const controller = new AbortController();
      const headers = new Headers(init?.headers);
      const timeoutHeader = headers.get(REQUEST_TIMEOUT_HEADER);
      headers.delete(REQUEST_TIMEOUT_HEADER);
      const id = setTimeout(
        () => controller.abort(new RequestTimeoutError()),
        timeoutHeader ? Number(timeoutHeader) : (options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS),
      );
      const bookSessionId = options.getBookSessionId?.();
      if (bookSessionId && !headers.has(BOOK_SESSION_HEADER)) {
        headers.set(BOOK_SESSION_HEADER, bookSessionId);
      }

      try {
        return await fetch(input, {
          ...init,
          headers,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(id);
      }
    },
  });
};

export const parseJsonResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
};

export const assertOkResponse = async (response: Response): Promise<void> => {
  if (!response.ok) {
    throw new Error(await response.text());
  }
};
