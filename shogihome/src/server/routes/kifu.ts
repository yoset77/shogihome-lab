import { Hono } from "hono";
import { validator } from "hono/validator";
import fs from "fs";
import { normalizePath } from "@/common/helpers/path";
import {
  clearKifuListCache,
  getKifuList,
  getPositionList,
  resolveKifuPath,
} from "@/server/helpers/kifu";
import { getNormalizedSfenAndHash } from "@/server/usi/sfen";
import * as kifuIndexDB from "@/server/database/kifu_index";
import * as kifuIndexSync from "@/server/kifu_index/sync";
import { writeFileAtomic } from "@/server/file/atomic";
import { KIFU_DIR } from "@/server/config";
import { sendError } from "@/server/errors";
import {
  createBodyLimit,
  DEFAULT_JSON_BODY_LIMIT,
  LARGE_BODY_LIMIT,
  type AppEnv,
} from "@/server/hono";
import { getOptionalInt, getString } from "@/server/routes/query";
import type { KifuSearchQuery, SfenExportRequest } from "@/common/file/sfen_export";
import { searchableStrategies, type SearchableStrategy } from "@/common/kifu/strategy_taxonomy";
import {
  cancelSfenExportJob,
  getSfenExportJob,
  startSfenExportJob,
} from "@/server/kifu_export/job";

function normalizeSearchQuery(query: KifuSearchQuery) {
  if (hasInvalidStrategy(query)) {
    return null;
  }
  let sfen = query.sfen;
  let sfenHash: bigint | undefined;
  if (sfen) {
    const normalized = getNormalizedSfenAndHash(sfen);
    if (!normalized) {
      return null;
    }
    sfen = normalized.sfen;
    sfenHash = normalized.hash;
  }
  return {
    sfen,
    sfenHash,
    keyword: query.keyword,
    player1: query.player1,
    player2: query.player2,
    isStrictTurn: query.isStrictTurn,
    startDate: query.startDate,
    strategy: query.strategy as SearchableStrategy | undefined,
  };
}

function hasInvalidStrategy(query: KifuSearchQuery): boolean {
  return !!query.strategy && !searchableStrategies.includes(query.strategy as SearchableStrategy);
}

function parseSearchQuery(value: unknown): KifuSearchQuery | null {
  if (!value || typeof value !== "object") return null;
  const query = value as Record<string, unknown>;
  const stringKeys = ["sfen", "keyword", "player1", "player2", "startDate", "strategy"] as const;
  for (const key of stringKeys) {
    if (query[key] !== undefined && typeof query[key] !== "string") return null;
  }
  if (query.isStrictTurn !== undefined && typeof query.isStrictTurn !== "boolean") return null;
  return {
    sfen: query.sfen as string | undefined,
    keyword: query.keyword as string | undefined,
    player1: query.player1 as string | undefined,
    player2: query.player2 as string | undefined,
    startDate: query.startDate as string | undefined,
    strategy: query.strategy as string | undefined,
    isStrictTurn: query.isStrictTurn as boolean | undefined,
  };
}

export const kifuRoutes = new Hono<AppEnv>()
  .get(
    "/list",
    validator("query", (value) => ({
      dir: getString(value.dir),
      reload: value.reload === "true",
    })),
    async (c) => {
      const query = c.req.valid("query");
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      if (query.reload) {
        clearKifuListCache();
      }
      const list = await getKifuList(KIFU_DIR);

      const dirParam = query.dir;
      if (
        dirParam &&
        normalizePath(dirParam)
          .split("/")
          .some((s) => s === "..")
      ) {
        return sendError(c, 400, "invalid dir");
      }
      const entriesMap = new Map<string, { name: string; path: string; isDirectory: boolean }>();
      const currentDirNormalized = dirParam ? normalizePath(dirParam) : "";
      const prefix = currentDirNormalized ? currentDirNormalized + "/" : "";
      const prefixLower = prefix.toLowerCase();

      list.forEach((file) => {
        const fileNormalized = normalizePath(file);
        if (fileNormalized.toLowerCase().startsWith(prefixLower)) {
          const relative = fileNormalized.substring(prefix.length);
          const parts = relative.split("/");
          if (parts.length > 1) {
            const dirName = parts[0];
            const dirPath = prefix + dirName;
            if (!entriesMap.has(dirName)) {
              entriesMap.set(dirName, { name: dirName, path: dirPath, isDirectory: true });
            }
          } else if (parts.length === 1 && parts[0] !== "") {
            const fileName = parts[0];
            entriesMap.set(fileName, { name: fileName, path: fileNormalized, isDirectory: false });
          }
        }
      });

      const responseList = Array.from(entriesMap.values()).sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      return c.json(responseList);
    },
  )

  .get(
    "/search",
    validator("query", (value) => ({
      sfen: getString(value.sfen),
      keyword: getString(value.keyword),
      player1: getString(value.player1),
      player2: getString(value.player2),
      isStrictTurn: value.isStrictTurn === "true",
      startDate: getString(value.startDate),
      strategy: getString(value.strategy),
      limit: getOptionalInt(value.limit),
      offset: getOptionalInt(value.offset),
    })),
    async (c) => {
      const query = c.req.valid("query");
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      const search = normalizeSearchQuery(query);
      if (!search) {
        return sendError(c, 400, hasInvalidStrategy(query) ? "Invalid strategy" : "Invalid sfen");
      }

      const results = kifuIndexDB.searchKifu({
        ...search,
        limit: query.limit,
        offset: query.offset,
      });
      return c.json(results);
    },
  )

  .get(
    "/search/count",
    validator("query", (value) => ({
      sfen: getString(value.sfen),
      keyword: getString(value.keyword),
      player1: getString(value.player1),
      player2: getString(value.player2),
      isStrictTurn: value.isStrictTurn === "true",
      startDate: getString(value.startDate),
      strategy: getString(value.strategy),
    })),
    (c) => {
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      const query = c.req.valid("query");
      const search = normalizeSearchQuery(query);
      if (!search) {
        return sendError(c, 400, hasInvalidStrategy(query) ? "Invalid strategy" : "Invalid sfen");
      }
      return c.json({ count: kifuIndexDB.getKifuSearchCount(search) });
    },
  )

  .post("/export/sfen", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), async (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const body = await c.req.json<Partial<SfenExportRequest>>();
    if (typeof body.filename !== "string" || !body.filename.toLowerCase().endsWith(".sfen")) {
      return sendError(c, 400, "filename must have a .sfen extension");
    }
    const searchQuery = parseSearchQuery(body.search);
    if (!searchQuery) {
      return sendError(c, 400, "search is required");
    }
    if (body.maxMoves !== undefined && (!Number.isInteger(body.maxMoves) || body.maxMoves <= 0)) {
      return sendError(c, 400, "maxMoves must be a positive integer");
    }
    const destination = resolveKifuPath(KIFU_DIR, body.filename);
    if (!destination) {
      return sendError(c, 400, "invalid filename");
    }
    if (fs.existsSync(destination) && body.overwrite !== true) {
      return sendError(c, 409, "file already exists");
    }
    const search = normalizeSearchQuery(searchQuery);
    if (!search) {
      return sendError(
        c,
        400,
        hasInvalidStrategy(searchQuery) ? "Invalid strategy" : "Invalid sfen",
      );
    }
    const job = startSfenExportJob({
      kifuDir: KIFU_DIR,
      outputPath: body.filename,
      search,
      targetSfen: search.sfen,
      maxMoves: body.maxMoves,
      standardInitialOnly: body.standardInitialOnly === true,
      overwrite: body.overwrite === true,
    });
    if (!job) {
      return sendError(c, 409, "another SFEN export is running");
    }
    return c.json(job, 202);
  })

  .get("/export/sfen/:jobId", (c) => {
    const job = getSfenExportJob(c.req.param("jobId"));
    return job ? c.json(job) : sendError(c, 404, "export job not found");
  })

  .delete("/export/sfen/:jobId", (c) => {
    return cancelSfenExportJob(c.req.param("jobId"))
      ? c.json({ cancelled: true })
      : sendError(c, 404, "running export job not found");
  })

  .get("/index/status", (c) => {
    return c.json(kifuIndexSync.getSyncStatus());
  })

  .get("/enabled", (c) => {
    return c.json({ enabled: !!KIFU_DIR });
  })

  .get(
    "/get",
    validator("query", (value) => ({ path: getString(value.path) })),
    async (c) => {
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      const { path: relPath } = c.req.valid("query");
      if (typeof relPath !== "string") {
        return sendError(c, 400, "path is required");
      }
      const fullPath = resolveKifuPath(KIFU_DIR, relPath);
      if (!fullPath) {
        return sendError(c, 403, "forbidden");
      }
      const data = await fs.promises.readFile(fullPath);
      return c.body(data, 200, { "Content-Type": "application/octet-stream" });
    },
  )

  .post(
    "/save",
    createBodyLimit(LARGE_BODY_LIMIT),
    validator("query", (value) => ({ path: getString(value.path) })),
    async (c) => {
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      const { path: relPath } = c.req.valid("query");
      if (typeof relPath !== "string") {
        return sendError(c, 400, "path is required");
      }
      const fullPath = resolveKifuPath(KIFU_DIR, relPath);
      if (!fullPath) {
        return sendError(c, 403, "forbidden");
      }
      await writeFileAtomic(fullPath, Buffer.from(await c.req.arrayBuffer()));
      clearKifuListCache();
      return c.text("ok");
    },
  );

export const sfenRoutes = new Hono<AppEnv>()
  .get(
    "/load",
    validator("query", (value) => ({ path: getString(value.path) })),
    async (c) => {
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      const { path: relPath } = c.req.valid("query");
      if (!relPath) {
        return sendError(c, 400, "path is required");
      }
      const fullPath = resolveKifuPath(KIFU_DIR, relPath);
      if (!fullPath || !fullPath.endsWith(".sfen")) {
        return sendError(c, 403, "Invalid path or unsupported file type");
      }
      const content = await fs.promises.readFile(fullPath, "utf-8");
      const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      return c.json({ lines });
    },
  )

  .get("/list", async (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const list = await getPositionList(KIFU_DIR);
    return c.json(list);
  });
