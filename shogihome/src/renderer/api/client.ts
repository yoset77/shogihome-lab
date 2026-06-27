import { hc } from "hono/client";
import type { AppType } from "@/common/api/rpc";

type ApiClientOptions = {
  timeoutMs?: number;
  getBookSessionId?: () => string | undefined;
};

export const createHonoApiClient = (options: ApiClientOptions = {}) => {
  return hc<AppType>(location.origin, {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const controller = new AbortController();
      const id = setTimeout(
        () => controller.abort(new Error("Request timeout")),
        options.timeoutMs ?? 10000,
      );
      const headers = new Headers(init?.headers);
      const bookSessionId = options.getBookSessionId?.();
      if (bookSessionId) {
        headers.set("X-Book-Session-Id", bookSessionId);
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
