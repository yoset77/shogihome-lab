import type { Context, Hono } from "hono";
import { serveStatic, type ServeStaticOptions } from "hono/serve-static";
import { getMimeType } from "hono/utils/mime";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import path from "path";
import { staticAssetPathPatterns } from "@/common/assets/static";
import { shogiHomePath } from "@/server/config";
import { sendError } from "@/server/errors";
import type { AppEnv } from "@/server/hono";

const maxBufferedAssetSize = 2 * 1024 * 1024;
const missingStaticFileCodes = new Set([
  "ENOENT",
  "ENOTDIR",
  "ENAMETOOLONG",
  "ELOOP",
  "ERR_INVALID_ARG_VALUE", // NUL byte in the request path.
]);
const isMissingStaticFile = (error: unknown) =>
  error instanceof Error && missingStaticFileCodes.has((error as NodeJS.ErrnoException).code ?? "");

// GET and HEAD use weak comparison for If-None-Match.
const matchesIfNoneMatch = (condition: string | undefined, tag: string) => {
  if (!condition) return false;
  return (
    condition.trim() === "*" ||
    condition.split(",").some((value) => value.trim().replace(/^W\//, "") === tag)
  );
};

// Ignore unsupported or malformed ranges; null denotes an unsatisfiable byte range.
const byteRange = (range: string | undefined, size: number) => {
  const match = range?.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return undefined;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return undefined;
  const start = match[1] ? first : Math.max(size - last, 0);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  return start > end || start >= size ? null : { start, end };
};

const staticContent = async (filePath: string, c: Context<AppEnv>) => {
  let file;
  try {
    file = await fs.promises.open(filePath, "r");
  } catch (error) {
    if (isMissingStaticFile(error)) return null;
    throw error;
  }

  let streaming = false;
  try {
    const stats = await file.stat();
    if (!stats.isFile()) return null;
    const hash = createHash("sha256");
    let content: Buffer<ArrayBuffer> | undefined;
    if (stats.size <= maxBufferedAssetSize) {
      // The body, length and validator must describe the same bytes.
      content = await file.readFile();
      hash.update(content);
    } else {
      // Keep the opened inode for delivery even if the pathname is replaced.
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
        hash.update(chunk);
      }
    }
    const tag = `"${hash.digest("hex")}"`;
    const size = content?.length ?? stats.size;

    const relativePath = path.relative(shogiHomePath, filePath).split(path.sep).join("/");
    const hashed = /^assets\/[^/]+-[\w-]{8}\.(?:js|css)$/i.test(relativePath);
    c.header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
    c.header("ETag", tag);
    // Validate before adding representation headers or creating a response stream.
    if (matchesIfNoneMatch(c.req.header("If-None-Match"), tag)) return c.body(null, 304);

    const ifRange = c.req.header("If-Range");
    const range =
      c.req.method === "GET" && (!ifRange || ifRange === tag)
        ? byteRange(c.req.header("Range"), size)
        : undefined;
    c.header("Accept-Ranges", "bytes");
    if (range === null) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    c.header("Content-Type", getMimeType(filePath) || "application/octet-stream");
    c.header("Content-Length", String(range ? range.end - range.start + 1 : size));
    if (c.req.method === "HEAD") return c.body(null, 200);
    if (range) c.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);

    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    if (content) return c.body(content.subarray(start, end + 1), range ? 206 : 200);

    const body = Readable.toWeb(
      file.createReadStream({ start, end }),
    ) as ReadableStream<Uint8Array>;
    const response = c.body(body, range ? 206 : 200);
    streaming = true;
    return response;
  } finally {
    if (!streaming) await file.close();
  }
};

const serveCachedStatic = (options: ServeStaticOptions<AppEnv>) =>
  serveStatic<AppEnv>({
    root: "",
    ...options,
    join: path.join,
    isDir: async (filePath) => {
      try {
        return (await fs.promises.stat(filePath)).isDirectory();
      } catch (error) {
        if (isMissingStaticFile(error)) return false;
        throw error;
      }
    },
    getContent: staticContent,
  });

export const registerStaticRoutes = (app: Hono<AppEnv>) => {
  app.all("/api", (c) => {
    return sendError(c, 404, "API endpoint not found");
  });

  app.all("/api/*", (c) => {
    return sendError(c, 404, "API endpoint not found");
  });

  app.use("*", serveCachedStatic({ root: shogiHomePath }));

  const fallback = serveCachedStatic({
    path: path.join(shogiHomePath, "index.html"),
  });
  app.get("*", async (c, next) => {
    // Never cache an HTML fallback under a missing asset URL.
    if (staticAssetPathPatterns.some((pattern) => pattern.test(c.req.path))) {
      return c.notFound();
    }
    return (await fallback(c, next)) || c.res;
  });
};
