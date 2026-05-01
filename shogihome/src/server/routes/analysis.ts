import express, { type Express } from "express";
import events from "node:events";
import fs from "fs";
import { getNormalizedSfenAndHash } from "@/server/usi/sfen";
import { resolveKifuPath } from "@/server/helpers/kifu";
import {
  cleanupAnalysisResults,
  deleteAnalysisResult,
  deleteAnalysisResultsByEngine,
  executeMigration,
  exportAnalysisResultsByEngine,
  getAnalysisDBStats,
  getAnalysisResults,
  getMigrationSummary,
} from "@/server/database/sqlite";
import { engineConfigCache } from "@/server/engine/list";
import { KIFU_DIR } from "@/server/config";
import { sendError } from "@/server/errors";

export const registerAnalysisRoutes = (app: Express) => {
  app.get("/api/analysis", async (req, res) => {
    const sfen = req.query.sfen;
    if (typeof sfen !== "string") {
      sendError(res, 400, "sfen is required");
      return;
    }

    const parsed = getNormalizedSfenAndHash(sfen);
    if (!parsed) {
      res.json([]);
      return;
    }

    console.log(`Analysis DB Query: sfen=${sfen} hash=${parsed.hash}`);

    const results = getAnalysisResults(parsed.hash, parsed.sfen);
    console.log(`Analysis DB Results: found ${results.length} records`);
    res.json(results);
  });

  app.get("/api/analysis/stats", async (req, res) => {
    const stats = getAnalysisDBStats();
    res.json(stats);
  });

  app.post("/api/analysis/delete_by_engine", express.json(), async (req, res) => {
    const engineId = req.body.engineId;
    if (typeof engineId !== "number" || !Number.isInteger(engineId) || engineId <= 0) {
      sendError(res, 400, "engineId must be a positive integer");
      return;
    }
    deleteAnalysisResultsByEngine(engineId);
    res.send("ok");
  });

  app.post("/api/analysis/cleanup", express.json(), async (req, res) => {
    const minDepth = req.body.minDepth;
    if (typeof minDepth !== "number" || !Number.isInteger(minDepth) || minDepth <= 0) {
      sendError(res, 400, "minDepth must be a positive integer");
      return;
    }
    cleanupAnalysisResults(minDepth);
    res.send("ok");
  });

  app.post("/api/analysis/delete", express.json(), async (req, res) => {
    const sfen = req.body.sfen;
    const engineId = req.body.engineId;
    const multipv = req.body.multipv;
    if (typeof sfen !== "string") {
      sendError(res, 400, "sfen is required");
      return;
    }
    if (typeof engineId !== "number" || !Number.isInteger(engineId) || engineId <= 0) {
      sendError(res, 400, "engineId must be a positive integer");
      return;
    }
    if (typeof multipv !== "number" || !Number.isInteger(multipv) || multipv < 1) {
      sendError(res, 400, "multipv must be a positive integer");
      return;
    }
    const parsed = getNormalizedSfenAndHash(sfen);
    if (!parsed) {
      sendError(res, 400, "invalid sfen");
      return;
    }
    deleteAnalysisResult(parsed.hash, parsed.sfen, engineId, multipv);
    res.send("ok");
  });

  app.post("/api/analysis/export", express.json(), async (req, res) => {
    const engineId = req.body.engineId;
    const relPath = req.body.filename as string;
    if (typeof engineId !== "number" || !Number.isInteger(engineId) || engineId <= 0) {
      sendError(res, 400, "engineId must be a positive integer");
      return;
    }
    if (!relPath) {
      sendError(res, 400, "filename is required");
      return;
    }
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }

    const fullPath = resolveKifuPath(KIFU_DIR, relPath);
    if (!fullPath) {
      sendError(res, 400, "invalid filename");
      return;
    }
    const generator = exportAnalysisResultsByEngine(engineId);
    const stream = fs.createWriteStream(fullPath);

    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.on("finish", resolve);
      (async () => {
        for (const chunk of generator) {
          if (!stream.write(chunk)) {
            await events.once(stream, "drain");
          }
        }
        stream.end();
      })().catch(reject);
    });

    res.send("ok");
  });

  app.get("/api/analysis/migrate/dry-run", async (req, res) => {
    const keyMapping = new Map<string, string>();
    const nameMapping = new Map<string, string>();
    for (const config of engineConfigCache.values()) {
      if (config.analysisDBGroupId) {
        keyMapping.set(config.id, config.analysisDBGroupId);
        nameMapping.set(config.analysisDBGroupId, config.analysisDBGroupName || config.name);
      }
    }
    const summary = getMigrationSummary(keyMapping, nameMapping);
    res.json(summary);
  });

  app.post("/api/analysis/migrate/execute", async (req, res) => {
    const keyMapping = new Map<string, string>();
    const nameMapping = new Map<string, string>();
    for (const config of engineConfigCache.values()) {
      if (config.analysisDBGroupId) {
        keyMapping.set(config.id, config.analysisDBGroupId);
        nameMapping.set(config.analysisDBGroupId, config.analysisDBGroupName || config.name);
      }
    }
    try {
      executeMigration(keyMapping, nameMapping);
      res.send("ok");
    } catch (e) {
      console.error("Migration failed:", e);
      sendError(res, 500, "Migration failed");
    }
  });
};
