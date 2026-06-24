import type http from "http";
import type express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ALLOWED_HOSTS, ALLOWED_ORIGINS } from "@/server/config";
import { sendError } from "@/server/errors";

export const isValidHost = (req: http.IncomingMessage) => {
  const host = req.headers.host;
  return host && ALLOWED_HOSTS.has(host);
};

export const validateHostHeader: express.RequestHandler = (req, res, next) => {
  if (!isValidHost(req)) {
    console.warn(`Blocked HTTP request with invalid Host header: ${req.headers.host}`);
    sendError(res, 403, "Forbidden (Invalid Host)");
    return;
  }
  next();
};

export const createHelmetMiddleware = () =>
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
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
    },
    hsts: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  });

export const createRateLimiter = () =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3000,
  });
