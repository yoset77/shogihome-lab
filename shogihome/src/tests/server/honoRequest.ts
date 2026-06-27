import type { Hono } from "hono";
import type { AppEnv } from "@/server/hono";

type JsonBody = Record<string, unknown> | unknown[];

export type TestResponse = {
  headers: Headers;
  status: number;
  body: Record<string, unknown>[] & Record<string, unknown>;
  textBody: string;
};

const createHeaders = (host: string, headers?: HeadersInit) => {
  const result = new Headers(headers);
  result.set("Host", host);
  return result;
};

export const requestApp = async (
  app: Hono<AppEnv>,
  method: string,
  path: string,
  options: {
    host?: string;
    headers?: HeadersInit;
    json?: JsonBody;
    body?: BodyInit;
  } = {},
): Promise<TestResponse> => {
  const headers = createHeaders(options.host ?? "localhost:8140", options.headers);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  }

  const response = await app.request(path, { method, headers, body });
  const textBody = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const parsedBody = (
    contentType.includes("application/json") && textBody ? JSON.parse(textBody) : {}
  ) as Record<string, unknown>[] | Record<string, unknown>;
  return {
    headers: response.headers,
    status: response.status,
    body: parsedBody as Record<string, unknown>[] & Record<string, unknown>,
    textBody,
  };
};
