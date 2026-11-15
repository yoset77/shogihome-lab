import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { requestApp } from "./honoRequest";
import type { AppEnv } from "@/server/hono";
import { registerStaticRoutes } from "@/server/routes/static";

const { SERVER_PORT, tempBaseDir } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const port = 8400 + Math.floor(Math.random() * 100);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-static-api-"));
  process.env.PORT = port.toString();
  process.env.SHOGIHOME_BASE_PATH = dir;
  return { SERVER_PORT: port, tempBaseDir: dir };
});

// Prepare a minimal runtime asset tree so that the static route can find index.html
// without depending on a previous production build.
const staticDir = path.join(tempBaseDir, "docs", "webapp");
fs.mkdirSync(staticDir, { recursive: true });
fs.writeFileSync(
  path.join(staticDir, "index.html"),
  "<!doctype html><html><head></head><body></body></html>",
);
const fixtures = {
  "board/texture.webp": "texture-one",
  "assets/main-A1b2_Cd3.js": "export const value = 1;",
  "assets/main-A1b2_Cd3.css": "body { color: black; }",
  "ASSETS/main-A1b2_Cd3.JS": "export const value = 1;",
  "assets/unversioned.js": "export const value = 2;",
  "sw.js": "// service worker",
  "manifest.webmanifest": '{"name":"test"}',
  "favicon.png": "favicon fixture",
  "runtime.wasm": "wasm fixture",
  "puzzles-manifest.json": "[]",
  "sound/piece.mp3": "0123456789",
};
for (const [name, contents] of Object.entries(fixtures)) {
  const filePath = path.join(staticDir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

import { app } from "@/server/main";

const host = `localhost:${SERVER_PORT}`;

describe("Static routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  it.each([
    "/some-vue-route",
    "/v1.2/some-vue-route",
    "/?usen=~0.7ku&mobile",
    "/some-vue-route?file=/board/missing.png",
  ])("serves index.html for SPA route %s", async (url) => {
    const response = await requestApp(app, "GET", url, { host });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.textBody).toContain("<!doctype html>");
  });

  it.each([
    ["long segment", `/${"a".repeat(300)}`, 200],
    ["long segment with extension", `/${"a".repeat(300)}.png`, 404],
    ["long nested path", `/${Array(1000).fill("abcd").join("/")}`, 200],
    ["long nested asset path", `/${Array(1000).fill("abcd").join("/")}.png`, 404],
    ["NUL path", "/%00", 200],
    ["NUL path with extension", "/%00.png", 404],
    ["NUL asset path", "/assets/%00", 404],
    ["embedded NUL", "/a%00b", 200],
    ["trailing NUL", "/favicon.png%00", 404],
  ])("handles %s without internal errors", async (_name, url, status) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const method of ["GET", "HEAD"]) {
      const response = await requestApp(app, method, url, { host });
      expect(response.status).toBe(status);
      if (status === 200) {
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(response.headers.has("etag")).toBe(true);
        if (method === "GET") expect(response.textBody).toContain("<!doctype html>");
      } else {
        expect(response.textBody).not.toContain("<!doctype html>");
        expect(response.headers.has("cache-control")).toBe(false);
        expect(response.headers.has("etag")).toBe(false);
      }
      if (method === "HEAD") expect(response.textBody).toBe("");
    }
    expect(log).not.toHaveBeenCalled();
  });

  it.each(["/sound", "/sound/"])("returns 404 for directory %s without logging", async (url) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await requestApp(app, "GET", url, { host });
    expect(response.status).toBe(404);
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("cache-control")).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  describe.each(["stat", "open"] as const)("filesystem %s failures", (operation) => {
    it.each(["ENOENT", "ENOTDIR", "ENAMETOOLONG", "ELOOP", "ERR_INVALID_ARG_VALUE"])(
      "treats %s as a missing asset without logging",
      async (code) => {
        const error = Object.assign(new Error("unresolvable asset"), { code });
        if (operation === "stat") {
          vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(error);
        }
        const open = vi.spyOn(fs.promises, "open").mockRejectedValueOnce(error);
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const response = await requestApp(app, "GET", "/favicon.png", { host });
        expect(open).toHaveBeenCalledWith(path.join(staticDir, "favicon.png"), "r");
        expect(response.status).toBe(404);
        expect(response.headers.has("etag")).toBe(false);
        expect(response.headers.has("cache-control")).toBe(false);
        expect(log).not.toHaveBeenCalled();
      },
    );

    it.each(["EACCES", "EIO"])("preserves %s as an internal error", async (code) => {
      const filePath = path.join(staticDir, "favicon.png");
      const error = Object.assign(new Error(filePath), { code });
      const failure = vi.spyOn(fs.promises, operation).mockRejectedValueOnce(error);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = await requestApp(app, "GET", "/favicon.png", { host });
      expect(failure).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(500);
      expect(response.textBody).not.toContain(filePath);
      expect(response.headers.has("etag")).toBe(false);
      expect(response.headers.has("cache-control")).toBe(false);
      expect(log).toHaveBeenCalledExactlyOnceWith("Unhandled error:", error);
    });
  });

  it("does not fall back to index.html for unknown API routes", async () => {
    const response = await requestApp(app, "GET", "/api/unknown", { host });

    expect(response.status).toBe(404);
    expect(response.textBody).toContain("API endpoint not found");
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("cache-control")).toBe(false);
  });

  it.each(["GET", "HEAD"])("revalidates fixed-name images on %s", async (method) => {
    const first = await requestApp(app, "GET", "/board/texture.webp", { host });
    const tag = first.headers.get("etag")!;
    expect(first.status).toBe(200);
    expect(first.textBody).toBe("texture-one");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    expect(first.headers.has("last-modified")).toBe(false);
    expect(tag).toMatch(/^".+"$/);
    expect(first.headers.get("content-security-policy")).toContain("default-src 'self'");

    for (const condition of [
      tag,
      `W/${tag}`,
      `"other", ${tag}`,
      `${tag}, W/"other"`,
      `"other", W/${tag}, "another"`,
      ` \tW/${tag}\t `,
      "*",
    ]) {
      const cached = await requestApp(app, method, "/board/texture.webp", {
        host,
        headers: { "If-None-Match": condition },
      });
      expect(cached.status).toBe(304);
      expect(cached.textBody).toBe("");
      expect(cached.headers.get("etag")).toBe(tag);
      expect(cached.headers.get("cache-control")).toBe("no-cache");
      expect(cached.headers.has("last-modified")).toBe(false);
      expect(cached.headers.get("content-security-policy")).toBe(
        first.headers.get("content-security-policy"),
      );
      expect(cached.headers.has("content-length")).toBe(false);
      expect(cached.headers.has("content-type")).toBe(false);
      expect(cached.headers.has("content-range")).toBe(false);
    }
  });

  it.each(["GET", "HEAD"])("does not accept other or unquoted ETags on %s", async (method) => {
    const first = await requestApp(app, "GET", "/board/texture.webp", { host });
    const tag = first.headers.get("etag")!;
    for (const condition of [
      "",
      '"other"',
      'W/"other"',
      '"other", W/"another"',
      tag.slice(1, -1),
      `W/${tag.slice(1, -1)}`,
      `w/${tag}`,
    ]) {
      const response = await requestApp(app, method, "/board/texture.webp", {
        host,
        headers: { "If-None-Match": condition },
      });
      expect(response.status).toBe(200);
      expect(response.textBody).toBe(method === "GET" ? "texture-one" : "");
      expect(response.headers.get("etag")).toBe(tag);
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it.each(["GET", "HEAD"])("ignores timestamp validators on %s", async (method) => {
    const first = await requestApp(app, method, "/board/texture.webp", { host });
    const modified = fs.statSync(path.join(staticDir, "board/texture.webp")).mtime.toUTCString();
    expect(first.headers.has("last-modified")).toBe(false);

    const validators: Record<string, string>[] = [
      { "If-Modified-Since": modified },
      { "If-Modified-Since": "invalid date" },
      { "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" },
      { "If-Modified-Since": new Date("2100-01-01T00:00:00Z").toUTCString() },
      { "If-None-Match": '"different"', "If-Modified-Since": modified },
    ];
    for (const headers of validators) {
      const response = await requestApp(app, method, "/board/texture.webp", { host, headers });
      expect(response.status).toBe(200);
      expect(response.textBody).toBe(method === "GET" ? "texture-one" : "");
      expect(response.headers.get("etag")).toBe(first.headers.get("etag"));
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.has("last-modified")).toBe(false);
    }

    const cached = await requestApp(app, method, "/board/texture.webp", {
      host,
      headers: {
        "If-None-Match": first.headers.get("etag")!,
        "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT",
      },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.has("last-modified")).toBe(false);
  });

  it("detects replacements even when the size and modification time are unchanged", async () => {
    const filePath = path.join(staticDir, "board/replaced.webp");
    fs.writeFileSync(filePath, "before");
    const modified = new Date("2025-01-01T00:00:00Z");
    fs.utimesSync(filePath, modified, modified);
    const first = await requestApp(app, "GET", "/board/replaced.webp", { host });
    fs.writeFileSync(filePath, "after!");
    fs.utimesSync(filePath, modified, modified);
    const validators: Record<string, string>[] = [
      { "If-Modified-Since": modified.toUTCString() },
      { "If-None-Match": first.headers.get("etag")! },
      {
        "If-None-Match": first.headers.get("etag")!,
        "If-Modified-Since": modified.toUTCString(),
      },
    ];
    for (const headers of validators) {
      const updated = await requestApp(app, "GET", "/board/replaced.webp", { host, headers });
      expect(updated.status).toBe(200);
      expect(updated.textBody).toBe("after!");
      expect(updated.headers.get("etag")).not.toBe(first.headers.get("etag"));
      expect(updated.headers.has("last-modified")).toBe(false);
    }
  });

  it("returns matching validators for HEAD without a response body", async () => {
    const get = await requestApp(app, "GET", "/board/texture.webp", { host });
    const head = await requestApp(app, "HEAD", "/board/texture.webp", { host });
    expect(head.status).toBe(200);
    expect(head.textBody).toBe("");
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(head.headers.get("cache-control")).toBe("no-cache");
    expect(head.headers.has("last-modified")).toBe(false);
    const cached = await requestApp(app, "HEAD", "/board/texture.webp", {
      host,
      headers: { "If-None-Match": get.headers.get("etag")! },
    });
    expect(cached.status).toBe(304);
    expect(cached.textBody).toBe("");
  });

  it.each([0, 1000, 262143, 262144, 262145, 300000, 1364354, 2097152, 2097153])(
    "uses the same whole-file ETag for GET and HEAD at %i bytes",
    async (size) => {
      const url = `/assets/size-${size}.js`;
      const content = Buffer.alloc(size, "a");
      fs.writeFileSync(path.join(staticDir, url), content);
      const expectedTag = `"${createHash("sha256").update(content).digest("hex")}"`;
      const get = await requestApp(app, "GET", url, { host });
      const head = await requestApp(app, "HEAD", url, { host });
      expect(get.status).toBe(200);
      expect(get.textBody).toBe(content.toString());
      expect(head.status).toBe(200);
      expect(head.textBody).toBe("");
      expect(head.headers.get("content-length")).toBe(String(size));
      expect(get.headers.get("etag")).toBe(expectedTag);
      expect(head.headers.get("etag")).toBe(expectedTag);
      expect(get.headers.has("last-modified")).toBe(false);
      expect(head.headers.has("last-modified")).toBe(false);

      for (const method of ["GET", "HEAD"]) {
        const cached = await requestApp(app, method, url, {
          host,
          headers: { "If-None-Match": expectedTag },
        });
        expect(cached.status).toBe(304);
        expect(cached.textBody).toBe("");
        expect(cached.headers.get("etag")).toBe(expectedTag);
        expect(cached.headers.has("last-modified")).toBe(false);
        expect(cached.headers.has("content-length")).toBe(false);
        expect(cached.headers.has("content-type")).toBe(false);
      }
    },
  );

  it("reads small assets once without creating response streams, including on 304", async () => {
    const open = fs.promises.open;
    const reads = vi.fn();
    const streams = vi.fn();
    const opens = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      const readFile = file.readFile.bind(file);
      vi.spyOn(file, "readFile").mockImplementation(async () => {
        reads();
        return readFile();
      });
      const createReadStream = file.createReadStream.bind(file);
      vi.spyOn(file, "createReadStream").mockImplementation((options) => {
        streams();
        return createReadStream(options);
      });
      return file;
    });
    const first = await requestApp(app, "GET", "/board/texture.webp", { host });
    const response = await requestApp(app, "GET", "/board/texture.webp", {
      host,
      headers: { "If-None-Match": first.headers.get("etag")! },
    });
    expect(first.textBody).toBe("texture-one");
    expect(response.status).toBe(304);
    expect(opens).toHaveBeenCalledTimes(2);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(streams).not.toHaveBeenCalled();
  });

  it.each([6, 2097153])(
    "keeps the body and ETag consistent after an atomic replacement at %i bytes",
    async (size) => {
      const filePath = path.join(staticDir, "board/atomic.webp");
      const replacementPath = `${filePath}.replacement`;
      const before = Buffer.alloc(size, "a");
      const after = Buffer.alloc(size, "b");
      const beforeTag = `"${createHash("sha256").update(before).digest("hex")}"`;
      const afterTag = `"${createHash("sha256").update(after).digest("hex")}"`;
      for (const [method, headers] of [
        ["GET", {}],
        ["HEAD", {}],
        ["GET", { Range: "bytes=2-5" }],
      ] as const) {
        fs.writeFileSync(filePath, before);
        fs.writeFileSync(replacementPath, after);
        const open = fs.promises.open;
        const read = vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
          const file = await open(...args);
          fs.renameSync(replacementPath, filePath);
          return file;
        });
        const first = await requestApp(app, method, "/board/atomic.webp", { host, headers });
        expect(first.status).toBe("Range" in headers ? 206 : 200);
        expect(first.textBody).toBe(
          method === "HEAD" ? "" : "Range" in headers ? "aaaa" : before.toString(),
        );
        expect(first.headers.get("content-length")).toBe(String("Range" in headers ? 4 : size));
        expect(first.headers.get("etag")).toBe(beforeTag);
        read.mockRestore();

        const next = await requestApp(app, method, "/board/atomic.webp", {
          host,
          headers: { ...headers, "If-None-Match": beforeTag },
        });
        expect(next.status).toBe("Range" in headers ? 206 : 200);
        expect(next.textBody).toBe(
          method === "HEAD" ? "" : "Range" in headers ? "bbbb" : after.toString(),
        );
        expect(next.headers.get("etag")).toBe(afterTag);
      }
    },
  );

  it("uses the buffered byte length when a small file changes after stat", async () => {
    const filePath = path.join(staticDir, "board/resized.webp");
    fs.writeFileSync(filePath, "before");
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
      const file = await open(...args);
      const readFile = file.readFile.bind(file);
      vi.spyOn(file, "readFile").mockImplementationOnce(async () => {
        fs.writeFileSync(filePath, "longer replacement");
        return readFile();
      });
      return file;
    });
    const response = await requestApp(app, "GET", "/board/resized.webp", { host });
    expect(response.status).toBe(200);
    expect(response.textBody).toBe("longer replacement");
    expect(response.headers.get("content-length")).toBe("18");
    expect(response.headers.get("etag")).toBe(
      `"${createHash("sha256").update("longer replacement").digest("hex")}"`,
    );
  });

  it.each([1000, 2097153])(
    "closes the file after HEAD and conditional responses at %i bytes",
    async (size) => {
      const filePath = path.join(staticDir, "closed.js");
      fs.writeFileSync(filePath, Buffer.alloc(size, "a"));
      const tag = `"${createHash("sha256").update(Buffer.alloc(size, "a")).digest("hex")}"`;
      for (const [method, headers, status] of [
        ["HEAD", {}, 200],
        ["GET", { "If-None-Match": tag }, 304],
        ["GET", { Range: "bytes=9999999-" }, 416],
      ] as const) {
        const open = fs.promises.open;
        let handle: FileHandle | undefined;
        let streams: ReturnType<typeof vi.spyOn> | undefined;
        const opened = vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
          const file = await open(...args);
          handle = file;
          streams = vi.spyOn(file, "createReadStream");
          return file;
        });
        const response = await requestApp(app, method, "/closed.js", { host, headers });
        expect(response.status).toBe(status);
        expect(handle?.fd).toBe(-1);
        // Large files have only the hashing stream, never a response stream.
        expect(streams).toHaveBeenCalledTimes(size > 2097152 ? 1 : 0);
        opened.mockRestore();
      }
    },
  );

  it.each(["consumed", "cancelled"])(
    "closes the large-file descriptor when the response body is %s",
    async (action) => {
      const filePath = path.join(staticDir, "streamed.js");
      fs.writeFileSync(filePath, Buffer.alloc(2097153, "a"));
      const open = fs.promises.open;
      let handle: FileHandle | undefined;
      let closed: Promise<unknown> | undefined;
      vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
        const file = await open(...args);
        handle = file;
        const createReadStream = file.createReadStream.bind(file);
        vi.spyOn(file, "createReadStream").mockImplementation((options) => {
          const stream = createReadStream(options);
          if (options?.autoClose !== false) {
            closed = new Promise<void>((resolve) => stream.once("close", resolve));
          }
          return stream;
        });
        return file;
      });
      const response = await app.request("/streamed.js", { headers: { Host: host } });
      expect(response.status).toBe(200);
      expect(closed).toBeDefined();
      if (action === "cancelled") await response.body!.cancel();
      else expect((await response.arrayBuffer()).byteLength).toBe(2097153);
      await closed;
      expect(handle?.fd).toBe(-1);
    },
  );

  it("sets cache headers without depending on preceding middleware", async () => {
    const isolated = new Hono<AppEnv>();
    registerStaticRoutes(isolated);
    const get = await requestApp(isolated, "GET", "/board/texture.webp", { host });
    const head = await requestApp(isolated, "HEAD", "/board/texture.webp", { host });
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-cache");
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    const cached = await requestApp(isolated, "GET", "/board/texture.webp", {
      host,
      headers: { "If-None-Match": head.headers.get("etag")! },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("cache-control")).toBe("no-cache");
  });

  it.each(["GET", "HEAD"])(
    "returns 404 if a file disappears before opening on %s",
    async (method) => {
      const filePath = path.join(staticDir, "disappearing.js");
      fs.writeFileSync(filePath, "removed before opening");
      const open = fs.promises.open;
      const read = vi.spyOn(fs.promises, "open").mockImplementationOnce((...args) => {
        fs.unlinkSync(filePath);
        return open(...args);
      });
      const response = await requestApp(app, method, "/disappearing.js", { host });
      expect(read).toHaveBeenCalledWith(filePath, "r");
      expect(response.status).toBe(404);
      expect(response.headers.has("etag")).toBe(false);
      expect(response.headers.has("last-modified")).toBe(false);
      expect(response.headers.has("content-length")).toBe(false);
      expect(response.headers.has("cache-control")).toBe(false);
    },
  );

  it.each([
    ["GET", 1000],
    ["HEAD", 1000],
    ["GET", 2097153],
    ["HEAD", 2097153],
  ])("closes the file after a read failure on %s at %i bytes", async (method, size) => {
    const filePath = path.join(staticDir, "read-error.js");
    fs.writeFileSync(filePath, Buffer.alloc(size, "a"));
    const open = fs.promises.open;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
      const file = await open(...args);
      close = vi.spyOn(file, "close");
      const error = Object.assign(new Error(filePath), { code: "EIO" });
      vi.spyOn(file, "readFile").mockRejectedValue(error);
      vi.spyOn(file, "createReadStream").mockReturnValue(
        Readable.from(
          (async function* () {
            yield Buffer.from("partial content");
            throw error;
          })(),
        ) as fs.ReadStream,
      );
      return file;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await requestApp(app, method, "/read-error.js", { host });
    expect(response.status).toBe(500);
    expect(response.textBody).not.toContain(filePath);
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("last-modified")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.has("cache-control")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["js", "css"])("makes only hashed generated %s assets immutable", async (extension) => {
    const response = await requestApp(app, "GET", `/assets/main-A1b2_Cd3.${extension}`, {
      host,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const cached = await requestApp(app, "GET", `/assets/main-A1b2_Cd3.${extension}`, {
      host,
      headers: { "If-None-Match": response.headers.get("etag")! },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("cache-control")).toBe(response.headers.get("cache-control"));
  });

  it("recognizes hashed assets regardless of path casing", async () => {
    const response = await requestApp(app, "GET", "/ASSETS/main-A1b2_Cd3.JS", { host });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it.each([
    "/",
    "/some-vue-route",
    "/index.html",
    "/sw.js",
    "/manifest.webmanifest",
    "/favicon.png",
    "/runtime.wasm",
    "/puzzles-manifest.json",
    "/assets/unversioned.js",
    "/board/texture.webp?__WB_REVISION__=test",
  ])("requires revalidation for %s", async (url) => {
    const response = await requestApp(app, "GET", url, { host });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.has("etag")).toBe(true);
    expect(response.headers.has("last-modified")).toBe(false);
  });

  it.each([
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=7-20", "789", "bytes 7-9/10"],
    ["bytes=-20", "0123456789", "bytes 0-9/10"],
  ])("uses the whole-file ETag for sound Range %s", async (range, body, contentRange) => {
    const full = await requestApp(app, "GET", "/sound/piece.mp3", { host });
    const partial = await requestApp(app, "GET", "/sound/piece.mp3", {
      host,
      headers: { Range: range },
    });
    expect(partial.status).toBe(206);
    expect(partial.textBody).toBe(body);
    expect(partial.headers.get("content-range")).toBe(contentRange);
    expect(partial.headers.get("content-length")).toBe(String(body.length));
    expect(partial.headers.get("cache-control")).toBe("no-cache");
    expect(partial.headers.get("etag")).toBe(full.headers.get("etag"));
    expect(partial.headers.has("last-modified")).toBe(false);
  });

  it("returns 416 for unsatisfiable sound ranges with the whole-file ETag", async () => {
    const full = await requestApp(app, "GET", "/sound/piece.mp3", { host });
    const invalid = await requestApp(app, "GET", "/sound/piece.mp3", {
      host,
      headers: { Range: "bytes=20-30" },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
    expect(invalid.headers.get("etag")).toBe(full.headers.get("etag"));
    expect(invalid.headers.has("last-modified")).toBe(false);
  });

  it("evaluates If-None-Match before satisfiable and unsatisfiable ranges", async () => {
    const full = await requestApp(app, "GET", "/sound/piece.mp3", { host });
    const tag = full.headers.get("etag")!;
    for (const range of ["bytes=2-5", "bytes=20-30"]) {
      for (const condition of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
        const response = await requestApp(app, "GET", "/sound/piece.mp3", {
          host,
          headers: { Range: range, "If-None-Match": condition },
        });
        expect(response.status).toBe(304);
        expect(response.textBody).toBe("");
        expect(response.headers.get("etag")).toBe(tag);
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(response.headers.has("content-range")).toBe(false);
        expect(response.headers.has("content-length")).toBe(false);
        expect(response.headers.has("content-type")).toBe(false);
      }
    }
    const modified = await requestApp(app, "GET", "/sound/piece.mp3", {
      host,
      headers: { Range: "bytes=2-5", "If-None-Match": '"other"' },
    });
    expect(modified.status).toBe(206);
    expect(modified.textBody).toBe("2345");
    expect(modified.headers.get("etag")).toBe(tag);
  });

  it("honors If-Range only when it matches the strong whole-file ETag", async () => {
    const full = await requestApp(app, "GET", "/sound/piece.mp3", { host });
    const tag = full.headers.get("etag")!;
    for (const condition of [tag, '"other"', `W/${tag}`, new Date().toUTCString()]) {
      const response = await requestApp(app, "GET", "/sound/piece.mp3", {
        host,
        headers: { Range: "bytes=2-5", "If-Range": condition },
      });
      expect(response.status).toBe(condition === tag ? 206 : 200);
      expect(response.textBody).toBe(condition === tag ? "2345" : full.textBody);
      expect(response.headers.get("content-length")).toBe(condition === tag ? "4" : "10");
      expect(response.headers.get("etag")).toBe(tag);
      expect(response.headers.has("content-range")).toBe(condition === tag);
    }
  });

  it("ignores Range on HEAD without losing cache validators", async () => {
    const get = await requestApp(app, "GET", "/sound/piece.mp3", { host });
    const head = await requestApp(app, "HEAD", "/sound/piece.mp3", {
      host,
      headers: { Range: "bytes=2-5" },
    });
    expect(head.status).toBe(200);
    expect(head.textBody).toBe("");
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.has("content-range")).toBe(false);
    const cached = await requestApp(app, "HEAD", "/sound/piece.mp3", {
      host,
      headers: { Range: "bytes=2-5", "If-None-Match": get.headers.get("etag")! },
    });
    expect(cached.status).toBe(304);
    expect(cached.textBody).toBe("");
    expect(cached.headers.has("content-length")).toBe(false);
  });

  it("returns 416 for a range on an empty file", async () => {
    fs.writeFileSync(path.join(staticDir, "empty.js"), "");
    const response = await requestApp(app, "GET", "/empty.js", {
      host,
      headers: { Range: "bytes=0-" },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */0");
    expect(response.textBody).toBe("");
  });

  it.each([
    "items=2-5",
    "bytes=bad",
    "bytes=-",
    "bytes=0-1,4-5",
    "bytes=1e100-",
    "bytes=99999999999999999999-",
  ])("ignores unsupported or malformed Range %s", async (range) => {
    const response = await requestApp(app, "GET", "/sound/piece.mp3", {
      host,
      headers: { Range: range },
    });
    expect(response.status).toBe(200);
    expect(response.textBody).toBe("0123456789");
    expect(response.headers.has("etag")).toBe(true);
    expect(response.headers.has("content-range")).toBe(false);
  });

  it.each([
    "/board/missing.webp",
    "/assets/missing-A1b2_Cd3.js",
    "/missing.webmanifest",
    "/foo.PNG",
    "/BOARD/x.WEBP",
    "/BOARD/missing",
    "/ASSETS/missing",
    "/board?design=wood",
    "/robots.txt",
    "/missing.wasm",
    "/missing.map",
    "/missing.txt",
    "/missing.png?v=1",
    "/nested/missing.txt?path=/some-vue-route",
    "/.hidden",
    "/trailing.",
    "/sound/piece.mp3/nested.js",
  ])("does not cache HTML under missing asset URL %s", async (url) => {
    const response = await requestApp(app, "GET", url, { host });
    expect(response.status).toBe(404);
    expect(response.textBody).not.toContain("<!doctype html>");
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("cache-control")).toBe(false);
  });

  it("does not add static caching to successful API responses", async () => {
    const response = await requestApp(app, "GET", "/api/kifu/enabled", { host });
    expect(response.status).toBe(200);
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("cache-control")).toBe(false);
  });
});
