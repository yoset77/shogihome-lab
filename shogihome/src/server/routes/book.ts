import { Hono, type Context } from "hono";
import { validator } from "hono/validator";
import type { BookImportSettings } from "@/common/settings/book";
import { isBookFormat } from "@/common/book";
import { getBookList, resolveKifuPath, resolveWritableKifuPath } from "@/server/helpers/kifu";
import {
  clearBook,
  getBookFormat,
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
  bookSessionManager,
  getBookSession,
  runWithBookSessionLock,
} from "@/server/bookSessionManager";
import { KIFU_DIR, ONTHEFLY_THRESHOLD_MB, SBK_ONTHEFLY_THRESHOLD_MB } from "@/server/config";
import { HttpError, isMissingFile, sendError } from "@/server/errors";
import {
  createBodyLimit,
  DEFAULT_JSON_BODY_LIMIT,
  LARGE_BODY_LIMIT,
  type AppEnv,
} from "@/server/hono";
import { getOptionalInt, getString } from "@/server/routes/query";
import { readJsonBody } from "@/server/routes/body";
import { parseBookMove, parseBookSfen, parseBookUsi } from "@/server/book/validation";
import { t } from "@/common/i18n";

const BATCH_YIELD_INTERVAL = 100;

const runBookOperation = <T>(
  c: Context<AppEnv>,
  operation: (session: number) => T | Promise<T>,
  allowReopen = false,
): Promise<T> =>
  runWithBookSessionLock(c.req.header("X-Book-Session-Id"), async () =>
    operation(getBookSession(c.req.header("X-Book-Session-Id"), allowReopen)),
  );
let activeImport = false;

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
      let mode: "in-memory" | "on-the-fly";
      try {
        const sessionId = c.req.header("X-Book-Session-Id");
        mode = await runWithBookSessionLock(sessionId, async () => {
          const existed = sessionId ? bookSessionManager.has(sessionId) : false;
          const session = getBookSession(sessionId, true);
          try {
            return await openBook(session, fullPath, options);
          } catch (error) {
            if (!existed && sessionId) bookSessionManager.close(sessionId);
            throw error;
          }
        });
      } catch (error) {
        if (isMissingFile(error)) return sendError(c, 404, "book not found");
        throw error;
      }
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
    validator("query", (value) => ({
      path: getString(value.path),
      overwrite: getString(value.overwrite),
    })),
    async (c) => {
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      const { path: relPath, overwrite } = c.req.valid("query");
      if (typeof relPath !== "string") {
        return sendError(c, 400, "path is required");
      }
      if (overwrite !== undefined && overwrite !== "true" && overwrite !== "false") {
        return sendError(c, 400, "overwrite must be true or false");
      }
      const fullPath = resolveWritableKifuPath(KIFU_DIR, "book", relPath);
      if (!fullPath) {
        return sendError(c, 403, "forbidden");
      }
      const destination = fullPath;
      const kifuDir = KIFU_DIR;
      try {
        await runBookOperation(c, async (bookSession) => {
          const ext = { yane2016: ".db", apery: ".bin", sbk: ".sbk", ybb: ".ybb" }[
            getBookFormat(bookSession)
          ];
          if (resolveWritableKifuPath(kifuDir, "book", relPath, ext) !== destination) {
            throw new HttpError(400, t.serverInvalidDestination);
          }
          await saveBook(bookSession, destination, {
            overwrite: overwrite === "true",
            validateDestination: () =>
              resolveWritableKifuPath(kifuDir, "book", relPath, ext) === destination,
          });
        });
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") {
          return sendError(c, 409, t.serverFileExists);
        }
        throw error;
      }
      return c.text("ok");
    },
  )

  .post("/close", async (c) => {
    const sessionId = c.req.header("X-Book-Session-Id");
    await runWithBookSessionLock(sessionId, async () => closeBookSessionForHeader(sessionId));
    return c.text("ok");
  })

  .post(
    "/clear",
    validator("query", (value) => ({ format: getString(value.format) })),
    async (c) => {
      const { format } = c.req.valid("query");
      if (format !== undefined && !isBookFormat(format)) {
        return sendError(c, 400, "invalid format");
      }
      await runBookOperation(
        c,
        (bookSession) => clearBook(bookSession, format ?? getBookFormat(bookSession)),
        true,
      );
      return c.text("ok");
    },
  )

  .get(
    "/search",
    validator("query", (value) => ({ sfen: getString(value.sfen) })),
    async (c) => {
      const { sfen } = c.req.valid("query");
      if (typeof sfen !== "string") {
        return sendError(c, 400, "sfen is required");
      }
      const normalized = parseBookSfen(sfen);
      const moves = await runBookOperation(c, (bookSession) =>
        searchBookMoves(bookSession, normalized),
      );
      return c.json(moves);
    },
  )

  .post("/search/batch", createBodyLimit(LARGE_BODY_LIMIT), async (c) => {
    const body = await readJsonBody(c);
    const sfens = body.sfens;
    if (!Array.isArray(sfens)) {
      return sendError(c, 400, "sfens must be an array");
    }
    if (sfens.length > 100000) {
      return sendError(c, 400, "sfens array is too large (max 100000)");
    }
    const normalized = new Array<string>(sfens.length);
    for (let i = 0; i < sfens.length; i++) {
      normalized[i] = parseBookSfen(sfens[i]);
      if ((i + 1) % BATCH_YIELD_INTERVAL === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const results = await runBookOperation(c, async (bookSession) => {
      const batchResults = new Array(sfens.length);
      let nextIndex = 0;
      let completed = 0;
      const maxConcurrency = isBookOnTheFly(bookSession) ? 16 : 1;
      const concurrency = Math.min(sfens.length, maxConcurrency);
      const worker = async () => {
        while (nextIndex < sfens.length) {
          const i = nextIndex++;
          const sfen = sfens[i];
          const moves = await searchBookMoves(bookSession, normalized[i]);
          batchResults[i] = { sfen, moves };
          // Resolved lookup promises alone do not yield to network I/O.
          if (++completed % BATCH_YIELD_INTERVAL === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
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
      const normalized = parseBookSfen(sfen);
      const raw = await readJsonBody(c, t.serverInvalidBookMove);
      await runBookOperation(c, (bookSession) =>
        updateBookMove(bookSession, normalized, parseBookMove(raw, getBookFormat(bookSession))),
      );
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
      await runBookOperation(c, (bookSession) =>
        removeBookMove(bookSession, parseBookSfen(sfen), parseBookUsi(usi)),
      );
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
        updateBookMoveOrder(bookSession, parseBookSfen(sfen), parseBookUsi(usi), order),
      );
      return c.text("ok");
    },
  )

  .post("/import", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), async (c) => {
    const kifuDir = KIFU_DIR;
    if (!kifuDir) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const body = await readJsonBody(c);
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
    if (activeImport) throw new HttpError(503, t.serverBookImportBusy);
    activeImport = true;
    try {
      const summary = await runBookOperation(c, (bookSession) =>
        importBookMoves(bookSession, settings, undefined, kifuDir),
      );
      return c.json(summary);
    } finally {
      activeImport = false;
    }
  });
