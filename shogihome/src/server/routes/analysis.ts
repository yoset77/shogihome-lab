import { Hono } from "hono";
import { validator } from "hono/validator";
import events from "node:events";
import { getNormalizedSfenAndHash } from "@/server/usi/sfen";
import { resolveWritableKifuPath } from "@/server/helpers/kifu";
import { writeStreamAtomic } from "@/server/file/atomic_stream";
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
import { createBodyLimit, DEFAULT_JSON_BODY_LIMIT, type AppEnv } from "@/server/hono";
import { getString } from "@/server/routes/query";
import { parseJsonObject, readJsonBody } from "@/server/routes/body";
import { t } from "@/common/i18n";

type AnalysisDeleteRequest = {
  sfen?: unknown;
  engineId?: unknown;
  multipv?: unknown;
};

export const analysisRoutes = new Hono<AppEnv>()
  .get(
    "/",
    validator("query", (value) => ({ sfen: getString(value.sfen) })),
    async (c) => {
      const { sfen } = c.req.valid("query");
      if (typeof sfen !== "string") {
        return sendError(c, 400, "sfen is required");
      }

      const parsed = getNormalizedSfenAndHash(sfen);
      if (!parsed) {
        return c.json([]);
      }

      console.log(`Analysis DB Query: sfen=${sfen} hash=${parsed.hash}`);

      const results = getAnalysisResults(parsed.hash, parsed.sfen);
      console.log(`Analysis DB Results: found ${results.length} records`);
      return c.json(results);
    },
  )

  .get("/stats", async (c) => {
    const stats = getAnalysisDBStats();
    return c.json(stats);
  })

  .post("/delete_by_engine", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), async (c) => {
    const body = await readJsonBody(c);
    const engineId = body.engineId;
    if (typeof engineId !== "number" || !Number.isInteger(engineId) || engineId <= 0) {
      return sendError(c, 400, "engineId must be a positive integer");
    }
    deleteAnalysisResultsByEngine(engineId);
    return c.text("ok");
  })

  .post("/cleanup", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), async (c) => {
    const body = await readJsonBody(c);
    const minDepth = body.minDepth;
    if (typeof minDepth !== "number" || !Number.isInteger(minDepth) || minDepth <= 0) {
      return sendError(c, 400, "minDepth must be a positive integer");
    }
    cleanupAnalysisResults(minDepth);
    return c.text("ok");
  })

  .post(
    "/delete",
    createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
    validator("json", (value) => parseJsonObject(value) as AnalysisDeleteRequest),
    async (c) => {
      const body = c.req.valid("json");
      const sfen = body.sfen;
      const engineId = body.engineId;
      const multipv = body.multipv;
      if (typeof sfen !== "string") {
        return sendError(c, 400, "sfen is required");
      }
      if (typeof engineId !== "number" || !Number.isInteger(engineId) || engineId <= 0) {
        return sendError(c, 400, "engineId must be a positive integer");
      }
      if (typeof multipv !== "number" || !Number.isInteger(multipv) || multipv < 1) {
        return sendError(c, 400, "multipv must be a positive integer");
      }
      const parsed = getNormalizedSfenAndHash(sfen);
      if (!parsed) {
        return sendError(c, 400, "invalid sfen");
      }
      deleteAnalysisResult(parsed.hash, parsed.sfen, engineId, multipv);
      return c.text("ok");
    },
  )

  .post("/export", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), async (c) => {
    const body = await readJsonBody(c);
    const engineId = body.engineId;
    const relPath = body.filename;
    if (typeof engineId !== "number" || !Number.isInteger(engineId) || engineId <= 0) {
      return sendError(c, 400, "engineId must be a positive integer");
    }
    if (typeof relPath !== "string" || !relPath) {
      return sendError(c, 400, "filename is required");
    }
    if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
      return sendError(c, 400, "overwrite must be a boolean");
    }
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }

    const fullPath = resolveWritableKifuPath(KIFU_DIR, "book", relPath, ".db");
    if (!fullPath) {
      return sendError(c, 400, t.serverInvalidDestination);
    }
    const destination = fullPath;
    const kifuDir = KIFU_DIR;
    try {
      await writeStreamAtomic(
        destination,
        async (stream) => {
          for (const chunk of exportAnalysisResultsByEngine(engineId)) {
            if (!stream.write(chunk)) await events.once(stream, "drain");
          }
          stream.end();
        },
        {
          overwrite: body.overwrite === true,
          beforePublish: async () => {
            if (resolveWritableKifuPath(kifuDir, "book", relPath, ".db") !== destination) {
              throw new Error("Invalid analysis export destination");
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") {
        return sendError(c, 409, t.serverFileExists);
      }
      throw error;
    }

    return c.text("ok");
  })

  .get("/migrate/dry-run", async (c) => {
    const keyMapping = new Map<string, string>();
    const nameMapping = new Map<string, string>();
    for (const config of engineConfigCache.values()) {
      if (config.analysisDBGroupId) {
        keyMapping.set(config.id, config.analysisDBGroupId);
        nameMapping.set(config.analysisDBGroupId, config.analysisDBGroupName || config.name);
      }
    }
    const summary = getMigrationSummary(keyMapping, nameMapping);
    return c.json(summary);
  })

  .post("/migrate/execute", async (c) => {
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
      return c.text("ok");
    } catch (e) {
      console.error("Migration failed:", e);
      return sendError(c, 500, "Migration failed");
    }
  });
