import { Hono } from "hono";
import { Position } from "tsshogi";
import type { VisionTurn, VisionViewpoint } from "@/common/vision/types";
import { sendError } from "@/server/errors";
import { VISION_ENABLED, VISION_MAX_IMAGE_MB } from "@/server/config";
import { scanPositionImage } from "@/server/vision/command";
import { createBodyLimit, type AppEnv } from "@/server/hono";

const SUPPORTED_IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
]);

const parseTurn = (value: unknown): VisionTurn => {
  if (value === "white") {
    return "white";
  }
  return "black";
};

const parseViewpoint = (value: unknown): VisionViewpoint => {
  if (value === "white") {
    return "white";
  }
  return "black";
};

const parseMaxCandidates = (value: unknown): number => {
  if (typeof value !== "string") {
    return 5;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    return 5;
  }
  return parsed;
};

export const visionRoutes = new Hono<AppEnv>().post(
  "/scan",
  async (c, next) => {
    if (!VISION_ENABLED) {
      return sendError(c, 404, "vision backend is disabled");
    }
    const contentType = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();
    if (!contentType || !SUPPORTED_IMAGE_TYPES.has(contentType)) {
      return sendError(c, 415, "unsupported image type");
    }
    await next();
  },
  createBodyLimit(VISION_MAX_IMAGE_MB * 1024 * 1024),
  async (c) => {
    const contentType = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();
    const extension = SUPPORTED_IMAGE_TYPES.get(contentType ?? "");
    if (!extension) return sendError(c, 415, "unsupported image type");
    const image = Buffer.from(await c.req.arrayBuffer());
    if (image.length === 0) {
      return sendError(c, 400, "image body is required");
    }

    try {
      const result = await scanPositionImage({
        image,
        extension,
        sideToMove: parseTurn(c.req.query("sideToMove")),
        viewpoint: parseViewpoint(c.req.query("viewpoint")),
        maxCandidates: parseMaxCandidates(c.req.query("maxCandidates")),
      });
      if (!Position.newBySFEN(result.sfen)) {
        return sendError(c, 502, "vision backend returned invalid sfen");
      }
      return c.json(result);
    } catch (e) {
      console.warn("vision backend failed:", e);
      return sendError(c, 502, "vision backend failed");
    }
  },
);
