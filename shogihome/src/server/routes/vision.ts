import express, { type Express } from "express";
import { Position } from "tsshogi";
import type { VisionTurn, VisionViewpoint } from "@/common/vision/types";
import { sendError } from "@/server/errors";
import { VISION_ENABLED, VISION_MAX_IMAGE_MB } from "@/server/config";
import { scanPositionImage } from "@/server/vision/command";

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

export const registerVisionRoutes = (app: Express) => {
  app.post(
    "/api/vision/scan",
    express.raw({
      limit: `${VISION_MAX_IMAGE_MB}mb`,
      type: (req) => {
        const contentType = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
        return contentType ? SUPPORTED_IMAGE_TYPES.has(contentType) : false;
      },
    }),
    async (req, res) => {
      if (!VISION_ENABLED) {
        sendError(res, 404, "vision backend is disabled");
        return;
      }

      const contentType = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      const extension = contentType ? SUPPORTED_IMAGE_TYPES.get(contentType) : undefined;
      if (!extension) {
        sendError(res, 415, "unsupported image type");
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        sendError(res, 400, "image body is required");
        return;
      }

      try {
        const result = await scanPositionImage({
          image: req.body,
          extension,
          sideToMove: parseTurn(req.query.sideToMove),
          viewpoint: parseViewpoint(req.query.viewpoint),
          maxCandidates: parseMaxCandidates(req.query.maxCandidates),
        });
        if (!Position.newBySFEN(result.sfen)) {
          sendError(res, 502, "vision backend returned invalid sfen");
          return;
        }
        res.json(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendError(res, 502, message);
      }
    },
  );
};
