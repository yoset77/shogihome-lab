import express, { type Express } from "express";
import { getBookList, resolveKifuPath } from "@/background/helpers/kifu";
import {
  clearBook,
  importBookMoves,
  isBookOnTheFly,
  openBook,
  removeBookMove,
  saveBook,
  searchBookMoves,
  updateBookMove,
  updateBookMoveOrder,
} from "@/background/book";
import { closeBookSessionForRequest, getBookSession } from "@/server/bookSessionManager";
import { KIFU_DIR, ONTHEFLY_THRESHOLD_MB } from "@/server/config";
import { sendError } from "@/server/errors";

export const registerBookRoutes = (app: Express) => {
  app.post("/api/book/open", express.json(), async (req, res) => {
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }
    let relPath = req.query.path;
    if (typeof relPath !== "string") {
      sendError(res, 400, "path is required");
      return;
    }
    if (relPath.startsWith("server://")) {
      relPath = relPath.substring(9);
    }
    const fullPath = resolveKifuPath(KIFU_DIR, relPath);
    if (!fullPath) {
      sendError(res, 403, "forbidden");
      return;
    }
    const bookSession = getBookSession(req);
    // Override the threshold with the server-side environment variable to protect server memory.
    // Also, explicitly map expected properties to avoid passing unknown fields from req.body.
    const options = {
      forceOnTheFly: req.body?.forceOnTheFly === true,
      onTheFlyThresholdMB: ONTHEFLY_THRESHOLD_MB,
    };
    const mode = await openBook(bookSession, fullPath, options);
    res.json({ mode });
  });

  app.get("/api/book/list", async (req, res) => {
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }
    const list = await getBookList(KIFU_DIR);
    res.json(list);
  });

  app.post("/api/book/save", async (req, res) => {
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
    const bookSession = getBookSession(req);
    await saveBook(bookSession, fullPath);
    res.send("ok");
  });

  app.post("/api/book/close", async (req, res) => {
    closeBookSessionForRequest(req);
    res.send("ok");
  });

  app.post("/api/book/clear", async (req, res) => {
    const bookSession = getBookSession(req);
    clearBook(bookSession);
    res.send("ok");
  });

  app.get("/api/book/search", async (req, res) => {
    const sfen = req.query.sfen;
    if (typeof sfen !== "string") {
      sendError(res, 400, "sfen is required");
      return;
    }
    const bookSession = getBookSession(req);
    const moves = await searchBookMoves(bookSession, sfen);
    res.json(moves);
  });

  app.post("/api/book/search/batch", express.json({ limit: "10mb" }), async (req, res) => {
    const sfens = req.body.sfens;
    if (!Array.isArray(sfens)) {
      sendError(res, 400, "sfens must be an array");
      return;
    }
    if (sfens.length > 100000) {
      sendError(res, 400, "sfens array is too large (max 100000)");
      return;
    }
    const bookSession = getBookSession(req);
    const results = new Array(sfens.length);
    let nextIndex = 0;
    const maxConcurrency = isBookOnTheFly(bookSession) ? 16 : 1;
    const concurrency = Math.min(sfens.length, maxConcurrency);
    const worker = async () => {
      while (nextIndex < sfens.length) {
        const i = nextIndex++;
        const sfen = sfens[i];
        const moves = await searchBookMoves(bookSession, sfen);
        results[i] = { sfen, moves };
      }
    };
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    res.json(results);
  });

  app.post("/api/book/update", express.json(), async (req, res) => {
    const sfen = req.query.sfen;
    if (typeof sfen !== "string") {
      sendError(res, 400, "sfen is required");
      return;
    }
    const bookSession = getBookSession(req);
    await updateBookMove(bookSession, sfen, req.body);
    res.send("ok");
  });

  app.post("/api/book/remove", express.json(), async (req, res) => {
    const sfen = req.query.sfen;
    const usi = req.query.usi;
    if (typeof sfen !== "string" || typeof usi !== "string") {
      sendError(res, 400, "sfen and usi are required");
      return;
    }
    const bookSession = getBookSession(req);
    await removeBookMove(bookSession, sfen, usi);
    res.send("ok");
  });

  app.post("/api/book/order", express.json(), async (req, res) => {
    const sfen = req.query.sfen;
    const usi = req.query.usi;
    const order = parseInt(req.query.order as string, 10);
    if (typeof sfen !== "string" || typeof usi !== "string" || isNaN(order)) {
      sendError(res, 400, "sfen, usi and order are required");
      return;
    }
    const bookSession = getBookSession(req);
    await updateBookMoveOrder(bookSession, sfen, usi, order);
    res.send("ok");
  });

  app.post("/api/book/import", express.json(), async (req, res) => {
    if (!KIFU_DIR) {
      sendError(res, 404, "KIFU_DIR is not configured");
      return;
    }
    const minPly = req.body.minPly === undefined ? 0 : Number(req.body.minPly);
    const maxPly = req.body.maxPly === undefined ? 100 : Number(req.body.maxPly);
    if (!Number.isInteger(minPly) || minPly < 0) {
      sendError(res, 400, "minPly must be a non-negative integer");
      return;
    }
    if (!Number.isInteger(maxPly) || maxPly < 0) {
      sendError(res, 400, "maxPly must be a non-negative integer");
      return;
    }
    if (minPly > maxPly) {
      sendError(res, 400, "minPly must be less than or equal to maxPly");
      return;
    }
    const settings = {
      sourceType: req.body.sourceType,
      sourceDirectory: req.body.sourceDirectory,
      sourceRecordFile: req.body.sourceRecordFile,
      minPly,
      maxPly,
      playerCriteria: req.body.playerCriteria,
      playerName: req.body.playerName,
    };
    if (typeof settings.sourceRecordFile === "string" && settings.sourceRecordFile) {
      if (!settings.sourceRecordFile.startsWith("server://")) {
        sendError(res, 400, "sourceRecordFile must be a server:// URI");
        return;
      }
      const resolved = resolveKifuPath(KIFU_DIR, settings.sourceRecordFile.substring(9));
      if (!resolved) {
        sendError(res, 403, "forbidden sourceRecordFile");
        return;
      }
      settings.sourceRecordFile = resolved;
    }
    if (typeof settings.sourceDirectory === "string" && settings.sourceDirectory) {
      if (!settings.sourceDirectory.startsWith("server://")) {
        sendError(res, 400, "sourceDirectory must be a server:// URI");
        return;
      }
      const resolved = resolveKifuPath(KIFU_DIR, settings.sourceDirectory.substring(9));
      if (!resolved) {
        sendError(res, 403, "forbidden sourceDirectory");
        return;
      }
      settings.sourceDirectory = resolved;
    }
    const bookSession = getBookSession(req);
    const summary = await importBookMoves(bookSession, settings, undefined, KIFU_DIR);
    res.json(summary);
  });
};
