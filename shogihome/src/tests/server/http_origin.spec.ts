import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ALLOWED_ORIGINS } from "@/server/config";
import type { AppEnv } from "@/server/hono";
import { validateUnsafeRequestOrigin } from "@/server/security";

const allowedOrigin = ALLOWED_ORIGINS[0];
const allowedHost = new URL(allowedOrigin).host;

const createApp = () => {
  const handler = vi.fn((c) => c.json({ ok: true }));
  const app = new Hono<AppEnv>();
  app.use("*", validateUnsafeRequestOrigin);
  app.on(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"], "/test", handler);
  return { app, handler };
};

describe("HTTP Origin validation", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "allows %s from an allowed Origin",
    async (method) => {
      const { app, handler } = createApp();
      const response = await app.request("/test", {
        method,
        headers: { Host: allowedHost, Origin: allowedOrigin },
      });

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["missing", undefined],
    ["null", "null"],
    ["unauthorized", "https://evil.example"],
  ])("rejects an unsafe request with a %s Origin", async (_name, origin) => {
    const { app, handler } = createApp();
    const headers = new Headers({ Host: allowedHost });
    if (origin) headers.set("Origin", origin);

    const response = await app.request("/test", { method: "POST", headers });

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD", "OPTIONS"])("allows %s without an Origin", async (method) => {
    const { app, handler } = createApp();
    const response = await app.request("/test", {
      method,
      headers: { Host: allowedHost },
    });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});
