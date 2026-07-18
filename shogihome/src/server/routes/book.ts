import { Hono, type Context } from "hono";
import { validator } from "hono/validator";
import type { BookImportSettings } from "@/common/settings/book";
import { getBookList, resolveKifuPath } from "@/server/helpers/kifu";
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
} from "@/server/book";
import {
  closeBookSessionForHeader,
  getBookSession,
  runWithBookSessionLock,
} from "@/server/bookSessionManager";
import { KIFU_DIR, ONTHEFLY_THRESHOLD_MB, SBK_ONTHEFLY_THRESHOLD_MB } from "@/server/config";
import { sendError } from "@/server/errors";
import {
  createBodyLimit,
  DEFAULT_JSON_BODY_LIMIT,
  LARGE_BODY_LIMIT,
  type AppEnv,
} from "@/server/hono";
import { getOptionalInt, getString } from "@/server/routes/query";

const runBookOperation = <T>(
  c: Context<AppEnv>,
  operation: (session: number) => T | Promise<T>,
): Promise<T> =>
  runWithBookSessionLock(c.req.header("X-Book-Session-Id"), async () =>
    operation(getBookSession(c.req.header("X-Book-Session-Id"))),
  );

export const bookRoutes = new Hono<AppEnv>()
  .post(
    "/open",
    createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
    validator("query", (value) => ({ path: getString(value.path) })),
    async (c) => {
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      let { path: relPath } = c.req.valid("query");
      if (typeof relPath !== "string") {
        return sendError(c, 400, "path is required");
      }
      if (relPath.startsWith("server://")) {
        relPath = relPath.substring(9);
      }
      const fullPath = resolveKifuPath(KIFU_DIR, relPath);
      if (!fullPath) {
        return sendError(c, 403, "forbidden");
      }
      // Override the threshold with the server-side environment variable to protect server memory.
      // Also, explicitly map expected properties to avoid passing unknown fields from req.body.
      const options = {
        onTheFlyThresholdMB: ONTHEFLY_THRESHOLD_MB,
        sbkOnTheFlyThresholdMB: SBK_ONTHEFLY_THRESHOLD_MB,
      };
      const mode = await runBookOperation(c, (bookSession) =>
        openBook(bookSession, fullPath, options),
      );
      return c.json({ mode });
    },
  )

  .get("/list", async (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const list = await getBookList(KIFU_DIR);
    return c.json(list);
  })

  .post(
    "/save",
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
      await runBookOperation(c, (bookSession) => saveBook(bookSession, fullPath));
      return c.text("ok");
    },
  )

  .post("/close", async (c) => {
    const sessionId = c.req.header("X-Book-Session-Id");
    await runWithBookSessionLock(sessionId, async () => closeBookSessionForHeader(sessionId));
    return c.text("ok");
  })

  .post("/clear", async (c) => {
    await runBookOperation(c, (bookSession) => clearBook(bookSession));
    return c.text("ok");
  })

  .get(
    "/search",
    validator("query", (value) => ({ sfen: getString(value.sfen) })),
    async (c) => {
      const { sfen } = c.req.valid("query");
      if (typeof sfen !== "string") {
        return sendError(c, 400, "sfen is required");
      }
      const moves = await runBookOperation(c, (bookSession) => searchBookMoves(bookSession, sfen));
      return c.json(moves);
    },
  )

  .post("/search/batch", createBodyLimit(LARGE_BODY_LIMIT), async (c) => {
    const body = await c.req.json<{ sfens?: unknown }>();
    const sfens = body.sfens;
    if (!Array.isArray(sfens)) {
      return sendError(c, 400, "sfens must be an array");
    }
    if (sfens.length > 100000) {
      return sendError(c, 400, "sfens array is too large (max 100000)");
    }
    const results = await runBookOperation(c, async (bookSession) => {
      const batchResults = new Array(sfens.length);
      let nextIndex = 0;
      const maxConcurrency = isBookOnTheFly(bookSession) ? 16 : 1;
      const concurrency = Math.min(sfens.length, maxConcurrency);
      const worker = async () => {
        while (nextIndex < sfens.length) {
          const i = nextIndex++;
          const sfen = sfens[i];
          const moves = await searchBookMoves(bookSession, sfen);
          batchResults[i] = { sfen, moves };
        }
      };
      const workers = [];
      for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
      return batchResults;
    });
    return c.json(results);
  })

  .post(
    "/update",
    createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
    validator("query", (value) => ({ sfen: getString(value.sfen) })),
    async (c) => {
      const { sfen } = c.req.valid("query");
      if (typeof sfen !== "string") {
        return sendError(c, 400, "sfen is required");
      }
      const move = await c.req.json();
      await runBookOperation(c, (bookSession) => updateBookMove(bookSession, sfen, move));
      return c.text("ok");
    },
  )

  .post(
    "/remove",
    createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
    validator("query", (value) => ({
      sfen: getString(value.sfen),
      usi: getString(value.usi),
    })),
    async (c) => {
      const { sfen, usi } = c.req.valid("query");
      if (typeof sfen !== "string" || typeof usi !== "string") {
        return sendError(c, 400, "sfen and usi are required");
      }
      await runBookOperation(c, (bookSession) => removeBookMove(bookSession, sfen, usi));
      return c.text("ok");
    },
  )

  .post(
    "/order",
    createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
    validator("query", (value) => ({
      sfen: getString(value.sfen),
      usi: getString(value.usi),
      order: getString(value.order),
    })),
    async (c) => {
      const { sfen, usi, order: orderValue } = c.req.valid("query");
      const order = getOptionalInt(orderValue);
      if (typeof sfen !== "string" || typeof usi !== "string" || typeof order !== "number") {
        return sendError(c, 400, "sfen, usi and order are required");
      }
      await runBookOperation(c, (bookSession) =>
        updateBookMoveOrder(bookSession, sfen, usi, order),
      );
      return c.text("ok");
    },
  )

  .post("/import", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), async (c) => {
    const kifuDir = KIFU_DIR;
    if (!kifuDir) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const body = await c.req.json<Record<string, unknown>>();
    const minPly = body.minPly === undefined ? 0 : Number(body.minPly);
    const maxPly = body.maxPly === undefined ? 100 : Number(body.maxPly);
    if (!Number.isInteger(minPly) || minPly < 0) {
      return sendError(c, 400, "minPly must be a non-negative integer");
    }
    if (!Number.isInteger(maxPly) || maxPly < 0) {
      return sendError(c, 400, "maxPly must be a non-negative integer");
    }
    if (minPly > maxPly) {
      return sendError(c, 400, "minPly must be less than or equal to maxPly");
    }
    const settings: BookImportSettings = {
      sourceType: body.sourceType as BookImportSettings["sourceType"],
      sourceDirectory: typeof body.sourceDirectory === "string" ? body.sourceDirectory : "",
      sourceRecordFile: typeof body.sourceRecordFile === "string" ? body.sourceRecordFile : "",
      minPly,
      maxPly,
      playerCriteria: body.playerCriteria as BookImportSettings["playerCriteria"],
      playerName: typeof body.playerName === "string" ? body.playerName : undefined,
      importScore: body.importScore !== false,
    };
    if (typeof settings.sourceRecordFile === "string" && settings.sourceRecordFile) {
      if (!settings.sourceRecordFile.startsWith("server://")) {
        return sendError(c, 400, "sourceRecordFile must be a server:// URI");
      }
      const resolved = resolveKifuPath(kifuDir, settings.sourceRecordFile.substring(9));
      if (!resolved) {
        return sendError(c, 403, "forbidden sourceRecordFile");
      }
      settings.sourceRecordFile = resolved;
    }
    if (typeof settings.sourceDirectory === "string" && settings.sourceDirectory) {
      if (!settings.sourceDirectory.startsWith("server://")) {
        return sendError(c, 400, "sourceDirectory must be a server:// URI");
      }
      const resolved = resolveKifuPath(kifuDir, settings.sourceDirectory.substring(9));
      if (!resolved) {
        return sendError(c, 403, "forbidden sourceDirectory");
      }
      settings.sourceDirectory = resolved;
    }
    const summary = await runBookOperation(c, (bookSession) =>
      importBookMoves(bookSession, settings, undefined, kifuDir),
    );
    return c.json(summary);
  });
