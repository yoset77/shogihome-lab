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
import { createBodyLimit, LARGE_BODY_LIMIT, type AppEnv } from "@/server/hono";
import { getOptionalInt, getString } from "@/server/routes/query";

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
      limit: getOptionalInt(value.limit),
      offset: getOptionalInt(value.offset),
    })),
    async (c) => {
      const query = c.req.valid("query");
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      let sfen = query.sfen;
      let sfenHash: bigint | undefined;
      if (sfen) {
        const normalized = getNormalizedSfenAndHash(sfen);
        if (!normalized) {
          return sendError(c, 400, "Invalid sfen");
        }
        sfen = normalized.sfen;
        sfenHash = normalized.hash;
      }
      if (!sfen) {
        sfenHash = undefined;
      }

      const results = kifuIndexDB.searchKifu({
        sfen,
        sfenHash,
        keyword: query.keyword,
        player1: query.player1,
        player2: query.player2,
        isStrictTurn: query.isStrictTurn,
        startDate: query.startDate,
        limit: query.limit,
        offset: query.offset,
      });
      return c.json(results);
    },
  )

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
