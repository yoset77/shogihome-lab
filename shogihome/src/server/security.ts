import type http from "http";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import { MemoryStore, rateLimiter } from "hono-rate-limiter";
import { ALLOWED_HOSTS, ALLOWED_ORIGINS } from "@/server/config";
import { sendError } from "@/server/errors";

export const isValidHost = (req: http.IncomingMessage) => {
  const host = req.headers.host;
  return host && ALLOWED_HOSTS.has(host);
};

export const validateHostHeader = createMiddleware(async (c, next) => {
  const host = c.req.header("host");
  if (!host || !ALLOWED_HOSTS.has(host)) {
    console.warn(`Blocked HTTP request with invalid Host header: ${host}`);
    return sendError(c, 403, "Forbidden (Invalid Host)");
  }
  await next();
});

export const createSecureHeadersMiddleware = () =>
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      connectSrc: [
        "'self'",
        "ws:",
        "wss:",
        ...ALLOWED_ORIGINS.map((o) => o.replace("http", "ws").replace("https", "wss")),
      ],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
    },
    strictTransportSecurity: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  });

const rateLimitStore = new MemoryStore();

const getForwardedForClient = (value: string | undefined) =>
  value?.split(",", 1)[0]?.trim().toLowerCase() || undefined;

const getRemoteAddress = (c: Parameters<typeof getConnInfo>[0]) => {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
};

export const createRateLimiter = () =>
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 3000,
    store: rateLimitStore,
    keyGenerator: (c) => {
      const remoteAddress = getRemoteAddress(c);
      if (process.env.TRUST_PROXY === "true") {
        return getForwardedForClient(c.req.header("x-forwarded-for")) ?? remoteAddress ?? "unknown";
      }
      return remoteAddress ?? "unknown";
    },
  });
