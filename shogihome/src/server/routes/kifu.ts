import express, { type Express } from "express";
import fs from "fs";
import { normalizePath } from "@/common/helpers/path";
import {
  clearKifuListCache,
  getKifuList,
  getPositionList,
  resolveKifuPath,
} from "@/background/helpers/kifu";
import { getNormalizedSfenAndHash } from "@/background/usi/sfen";
import * as kifuIndexDB from "@/background/database/kifu_index";
import * as kifuIndexSync from "@/background/kifu_index/sync";
import { writeFileAtomic } from "@/background/file/atomic";
import { KIFU_DIR } from "@/server/config";
import { sendError } from "@/server/errors";

export const registerKifuRoutes = (app: Express) => {
  app.get("/api/kifu/list", async (req, res) => {
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }
    if (req.query.reload === "true") {
      clearKifuListCache();
    }
    const list = await getKifuList(KIFU_DIR);

    const dirParam = req.query.dir as string | undefined;
    if (
      dirParam &&
      normalizePath(dirParam)
        .split("/")
        .some((s) => s === "..")
    ) {
      sendError(res, 400, "invalid dir");
      return;
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

    res.json(responseList);
  });

  app.get("/api/kifu/search", async (req, res) => {
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }
    let sfen = req.query.sfen as string | undefined;
    let sfenHash: bigint | undefined;
    if (sfen) {
      const normalized = getNormalizedSfenAndHash(sfen);
      if (!normalized) {
        sendError(res, 400, "Invalid sfen");
        return;
      }
      sfen = normalized.sfen;
      sfenHash = normalized.hash;
    }
    if (!sfen) {
      sfenHash = undefined;
    }
    const keyword = req.query.keyword as string | undefined;
    const player1 = req.query.player1 as string | undefined;
    const player2 = req.query.player2 as string | undefined;
    const isStrictTurn = req.query.isStrictTurn === "true";
    const startDate = req.query.startDate as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

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
    res.json(results);
  });

  app.get("/api/kifu/index/status", (req, res) => {
    res.json(kifuIndexSync.getSyncStatus());
  });

  app.get("/api/kifu/enabled", (req, res) => {
    res.json({ enabled: !!KIFU_DIR });
  });

  app.get("/api/kifu/get", async (req, res) => {
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }
    const relPath = req.query.path;
    if (typeof relPath !== "string") {
      sendError(res, 400, "path is required");
      return;
    }
    const fullPath = resolveKifuPath(KIFU_DIR, relPath);
    if (!fullPath) {
      sendError(res, 403, "forbidden");
      return;
    }
    const data = await fs.promises.readFile(fullPath);
    res.send(data);
  });

  app.post("/api/kifu/save", express.raw({ limit: "10mb" }), async (req, res) => {
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }
    const relPath = req.query.path;
    if (typeof relPath !== "string") {
      sendError(res, 400, "path is required");
      return;
    }
    const fullPath = resolveKifuPath(KIFU_DIR, relPath);
    if (!fullPath) {
      sendError(res, 403, "forbidden");
      return;
    }
    await writeFileAtomic(fullPath, req.body);
    clearKifuListCache();
    res.send("ok");
  });

  app.get("/api/sfen/load", async (req, res) => {
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }
    const relPath = req.query.path as string;
    if (!relPath) {
      sendError(res, 400, "path is required");
      return;
    }
    const fullPath = resolveKifuPath(KIFU_DIR, relPath);
    if (!fullPath || !fullPath.endsWith(".sfen")) {
      sendError(res, 403, "Invalid path or unsupported file type");
      return;
    }
    const content = await fs.promises.readFile(fullPath, "utf-8");
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    res.json({ lines });
  });

  app.get("/api/sfen/list", async (req, res) => {
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }
    const list = await getPositionList(KIFU_DIR);
    res.json(list);
  });
};
