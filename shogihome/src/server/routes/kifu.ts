import type { Hono } from "hono";
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

export const registerKifuRoutes = (app: Hono<AppEnv>) => {
  app.get("/api/kifu/list", async (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    if (c.req.query("reload") === "true") {
      clearKifuListCache();
    }
    const list = await getKifuList(KIFU_DIR);

    const dirParam = c.req.query("dir");
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
  });

  app.get("/api/kifu/search", async (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    let sfen = c.req.query("sfen");
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
    const keyword = c.req.query("keyword");
    const player1 = c.req.query("player1");
    const player2 = c.req.query("player2");
    const isStrictTurn = c.req.query("isStrictTurn") === "true";
    const startDate = c.req.query("startDate");
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const offset = offsetParam ? parseInt(offsetParam, 10) : undefined;

    const results = kifuIndexDB.searchKifu({
      sfen,
      sfenHash,
      keyword,
      player1,
      player2,
      isStrictTurn,
      startDate,
      limit,
      offset,
    });
    return c.json(results);
  });

  app.get("/api/kifu/index/status", (c) => {
    return c.json(kifuIndexSync.getSyncStatus());
  });

  app.get("/api/kifu/enabled", (c) => {
    return c.json({ enabled: !!KIFU_DIR });
  });

  app.get("/api/kifu/get", async (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const relPath = c.req.query("path");
    if (typeof relPath !== "string") {
      return sendError(c, 400, "path is required");
    }
    const fullPath = resolveKifuPath(KIFU_DIR, relPath);
    if (!fullPath) {
      return sendError(c, 403, "forbidden");
    }
    const data = await fs.promises.readFile(fullPath);
    return c.body(data, 200, { "Content-Type": "application/octet-stream" });
  });

  app.post("/api/kifu/save", createBodyLimit(LARGE_BODY_LIMIT), async (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const relPath = c.req.query("path");
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
  });

  app.get("/api/sfen/load", async (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const relPath = c.req.query("path");
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
  });

  app.get("/api/sfen/list", async (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const list = await getPositionList(KIFU_DIR);
    return c.json(list);
  });
};
