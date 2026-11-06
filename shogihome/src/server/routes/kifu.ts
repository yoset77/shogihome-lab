import { Hono, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { validator } from "hono/validator";
import fs from "fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { normalizePath } from "@/common/helpers/path";
import { isReservedServerEntryName, isValidServerEntryName } from "@/common/file/upload";
import {
  clearKifuListCache,
  getKifuDirectoryList,
  getKifuList,
  getPositionList,
  getServerFileKind,
  resolveKifuDirectory,
  resolveNewKifuDirectory,
  resolveKifuPath,
  resolveWritableKifuPath,
} from "@/server/helpers/kifu";
import * as kifuIndexDB from "@/server/database/kifu_index";
import * as kifuIndexSync from "@/server/kifu_index/sync";
import {
  BOOK_UPLOAD_MAX_MB,
  FILE_UPLOAD_MAX_CONCURRENCY,
  KIFU_DIR,
  KIFU_UPLOAD_MAX_MB,
} from "@/server/config";
import { HttpError, isMissingFile, sendError } from "@/server/errors";
import { writeStreamAtomic } from "@/server/file/atomic_stream";
import {
  createBodyLimit,
  DEFAULT_JSON_BODY_LIMIT,
  LARGE_BODY_LIMIT,
  type AppEnv,
} from "@/server/hono";
import { getString } from "@/server/routes/query";
import { parseJsonObject, readJsonBody } from "@/server/routes/body";
import { readKifuSearchQuery, validateKifuSearchPagination } from "@/common/file/kifu_search";
import { t } from "@/common/i18n";
import { normalizeKifuSearchQuery } from "@/server/kifu_index/query";
import { kifuSearchRateLimiter } from "@/server/security";
import {
  cancelSfenExportJob,
  getSfenExportJob,
  startSfenExportJob,
} from "@/server/kifu_export/job";

const getUploadLimit = (kind: "kifu" | "book" | "sfen") =>
  (kind === "book" ? BOOK_UPLOAD_MAX_MB : KIFU_UPLOAD_MAX_MB) * 1024 * 1024;

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error;
let activeUploads = 0;

// Discard the request body before responding early. Returning a response
// while a large upload body is still in flight resets the connection, so
// the client sees ERR_CONNECTION_RESET instead of the intended status.
async function drainRequestBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) {
    return;
  }
  try {
    await body.pipeTo(new WritableStream({ write() {} }));
  } catch {
    // Ignore errors while discarding (e.g. the client already disconnected).
  }
}

function readSearchQuery(value: Record<string, unknown>) {
  try {
    const strict = value.isStrictTurn;
    const query = readKifuSearchQuery({
      ...value,
      isStrictTurn:
        strict === undefined || strict === "" || strict === "false"
          ? false
          : strict === "true"
            ? true
            : strict,
    });
    return { ...query, isStrictTurn: query.isStrictTurn ?? false };
  } catch {
    throw new HttpError(400, t.serverInvalidKifuSearch);
  }
}

function readSearchPagination(value: Record<string, unknown>) {
  try {
    const readInt = (input: unknown) => {
      if (input === undefined) return undefined;
      if (typeof input !== "string" || !/^\d+$/.test(input))
        throw new Error("Invalid search integer");
      return Number(input);
    };
    const limit = readInt(value.limit);
    const offset = readInt(value.offset);
    validateKifuSearchPagination(limit, offset);
    return { limit, offset };
  } catch {
    throw new HttpError(400, t.serverInvalidKifuPagination);
  }
}

// The HTTP turn filter is optional even though validation always returns a boolean.
function searchQueryValidator<Query extends ReturnType<typeof readSearchQuery>>(
  readQuery: (value: Record<string, unknown>) => Query,
) {
  return validator("query", readQuery) as MiddlewareHandler<
    AppEnv,
    string,
    {
      in: { query: Omit<Query, "isStrictTurn"> & { isStrictTurn?: string } };
      out: { query: Query };
    }
  >;
}

export const kifuRoutes = new Hono<AppEnv>()
  .post(
    "/directories",
    createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
    validator("json", (value, c) => {
      const body = parseJsonObject(value);
      if (
        typeof body.parent !== "string" ||
        typeof body.name !== "string" ||
        !isValidServerEntryName(body.name)
      ) {
        return sendError(c, 400, "invalid directory name or parent");
      }
      return { parent: body.parent, name: body.name };
    }),
    async (c) => {
      if (!KIFU_DIR) return sendError(c, 404, "KIFU_DIR is not configured");
      const { parent, name } = c.req.valid("json");
      const fullPath = resolveNewKifuDirectory(KIFU_DIR, parent, name);
      if (!fullPath) return sendError(c, 400, "invalid destination directory");
      try {
        await fs.promises.mkdir(fullPath);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          return sendError(c, 409, "directory already exists");
        }
        throw error;
      }
      clearKifuListCache();
      return c.json({ name, path: normalizePath(path.relative(KIFU_DIR, fullPath)) }, 201);
    },
  )
  .get(
    "/directories",
    validator("query", (value) => ({ dir: getString(value.dir) ?? "" })),
    async (c) => {
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      const dir = c.req.valid("query").dir;
      const directories = await getKifuDirectoryList(KIFU_DIR, dir);
      if (!directories) {
        return sendError(c, 404, "directory not found");
      }
      return c.json({ path: normalizePath(dir), directories });
    },
  )

  .post(
    "/upload",
    validator("query", (value) => ({
      path: getString(value.path),
      overwrite: getString(value.overwrite),
    })),
    async (c) => {
      // Responding while the upload body is still unread resets the
      // connection, so every early error in this handler drains the body
      // first. Otherwise the client sees ERR_CONNECTION_RESET instead of
      // the intended status.
      const fail = async (status: ContentfulStatusCode, message: string) => {
        await drainRequestBody(c.req.raw.body);
        return sendError(c, status, message);
      };
      const kifuDir = KIFU_DIR;
      if (!kifuDir) {
        return fail(404, "KIFU_DIR is not configured");
      }
      const query = c.req.valid("query");
      if (!query.path) {
        return fail(400, "path is required");
      }
      if (!isValidServerEntryName(query.path.split("/").at(-1) ?? "")) {
        return fail(400, "invalid file name");
      }
      if (
        query.overwrite !== undefined &&
        query.overwrite !== "true" &&
        query.overwrite !== "false"
      ) {
        return fail(400, "overwrite must be true or false");
      }
      const overwrite = query.overwrite === "true";
      const kind = getServerFileKind(query.path);
      const relDirectory = normalizePath(path.dirname(query.path));
      if (normalizePath(query.path).split("/").some(isReservedServerEntryName)) {
        return fail(403, "invalid path or unsupported file type");
      }
      if (kind && !resolveKifuDirectory(kifuDir, relDirectory === "." ? "" : relDirectory)) {
        return fail(404, "destination directory not found");
      }
      const fullPath = kind && resolveWritableKifuPath(kifuDir, kind, query.path);
      if (!kind || !fullPath) {
        return fail(403, "invalid path or unsupported file type");
      }
      const existed = fs.existsSync(fullPath);
      if (!overwrite && existed) {
        return fail(409, "file already exists");
      }

      const maxSize = getUploadLimit(kind);
      const contentLength = c.req.header("Content-Length");
      if (contentLength !== undefined) {
        const declaredSize = Number(contentLength);
        if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
          return fail(400, "invalid Content-Length");
        }
        if (declaredSize > maxSize) {
          return fail(413, "Payload Too Large");
        }
      }
      const body = c.req.raw.body;
      if (!body) {
        return fail(400, "file is empty");
      }
      if (activeUploads >= FILE_UPLOAD_MAX_CONCURRENCY) {
        return fail(429, "too many concurrent uploads");
      }

      let size = 0;
      activeUploads += 1;
      try {
        await writeStreamAtomic(
          fullPath,
          async (stream) => {
            await pipeline(
              Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
              new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  size += chunk.byteLength;
                  callback(size > maxSize ? new HttpError(413, "Payload Too Large") : null, chunk);
                },
                flush(callback) {
                  callback(size === 0 ? new HttpError(400, "file is empty") : null);
                },
              }),
              stream,
            );
            if (!resolveKifuDirectory(kifuDir, relDirectory === "." ? "" : relDirectory)) {
              throw new HttpError(403, "destination directory is no longer valid");
            }
          },
          { overwrite },
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          return fail(409, "file already exists");
        }
        throw error;
      } finally {
        activeUploads -= 1;
      }

      clearKifuListCache();
      return c.json(
        { path: normalizePath(query.path), kind, size, overwritten: existed },
        existed ? 200 : 201,
      );
    },
  )

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
    kifuSearchRateLimiter,
    searchQueryValidator((value) => ({
      ...readSearchQuery(value),
      ...readSearchPagination(value),
    })),
    async (c) => {
      const query = c.req.valid("query");
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      const results = kifuIndexDB.searchKifu({
        ...normalizeKifuSearchQuery(query),
        limit: query.limit,
        offset: query.offset,
      });
      return c.json(results);
    },
  )

  .get("/search/count", kifuSearchRateLimiter, searchQueryValidator(readSearchQuery), (c) => {
    if (!KIFU_DIR) {
      return sendError(c, 404, "KIFU_DIR is not configured");
    }
    const query = c.req.valid("query");
    return c.json({ count: kifuIndexDB.getKifuSearchCount(normalizeKifuSearchQuery(query)) });
  })

  .get("/search/statistics", kifuSearchRateLimiter, searchQueryValidator(readSearchQuery), (c) => {
    if (!KIFU_DIR) return sendError(c, 404, "KIFU_DIR is not configured");
    const query = c.req.valid("query");
    return c.json(kifuIndexDB.getKifuSearchStatistics(normalizeKifuSearchQuery(query)));
  })

  .post(
    "/export/sfen",
    kifuSearchRateLimiter,
    createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
    async (c) => {
      if (!KIFU_DIR) {
        return sendError(c, 404, "KIFU_DIR is not configured");
      }
      const body = await readJsonBody(c);
      if (typeof body.filename !== "string" || !body.filename.toLowerCase().endsWith(".sfen")) {
        return sendError(c, 400, "filename must have a .sfen extension");
      }
      const search = normalizeKifuSearchQuery(body.search);
      if (
        body.maxMoves !== undefined &&
        (typeof body.maxMoves !== "number" ||
          !Number.isInteger(body.maxMoves) ||
          body.maxMoves <= 0)
      ) {
        return sendError(c, 400, "maxMoves must be a positive integer");
      }
      const destination = resolveWritableKifuPath(KIFU_DIR, "sfen", body.filename);
      if (!destination) {
        return sendError(c, 400, t.serverInvalidDestination);
      }
      if (fs.existsSync(destination) && body.overwrite !== true) {
        return sendError(c, 409, "file already exists");
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
    },
  )

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
      let data: Buffer;
      try {
        data = await fs.promises.readFile(fullPath);
      } catch (error) {
        if (isMissingFile(error)) return sendError(c, 404, t.serverFileNotFound);
        throw error;
      }
      return c.body(new Uint8Array(data), 200, { "Content-Type": "application/octet-stream" });
    },
  )

  .post(
    "/save",
    createBodyLimit(LARGE_BODY_LIMIT),
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
      const fullPath = resolveWritableKifuPath(KIFU_DIR, "kifu", relPath);
      if (!fullPath) {
        return sendError(c, 400, t.serverInvalidDestination);
      }
      const kifuDir = KIFU_DIR;
      const data = Buffer.from(await c.req.arrayBuffer());
      try {
        await writeStreamAtomic(
          fullPath,
          async (stream) => {
            stream.end(data);
            await finished(stream);
          },
          {
            overwrite: overwrite === "true",
            beforePublish: async () => {
              if (resolveWritableKifuPath(kifuDir, "kifu", relPath) !== fullPath) {
                throw new HttpError(403, t.serverInvalidDestination);
              }
            },
          },
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST")
          return sendError(c, 409, t.serverFileExists);
        throw error;
      }
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
      let content: string;
      try {
        content = await fs.promises.readFile(fullPath, "utf-8");
      } catch (error) {
        if (isMissingFile(error)) return sendError(c, 404, t.serverFileNotFound);
        throw error;
      }
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
