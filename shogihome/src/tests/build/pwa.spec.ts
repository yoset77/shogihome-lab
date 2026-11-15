// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { resolveConfig } from "vite";
import type { VitePluginPWAAPI } from "vite-plugin-pwa";
import { getTempPathForTesting } from "@/tests/helpers/temp";

type Entry = { url: string; revision: string | null };

function inspectWorker(filePath: string) {
  let entries: Entry[] = [];
  let denylist: RegExp[] = [];
  const skipWaiting = vi.fn();
  const clientsClaim = vi.fn();
  const workbox = {
    precacheAndRoute: (manifest: Entry[]) => {
      entries = manifest;
    },
    cleanupOutdatedCaches: vi.fn(),
    createHandlerBoundToURL: vi.fn(),
    registerRoute: vi.fn(),
    clientsClaim,
    NavigationRoute: class {
      constructor(_handler: unknown, options: { denylist: RegExp[] }) {
        denylist = options.denylist;
      }
    },
  };
  const define = (_dependencies: string[], factory: (api: typeof workbox) => void) =>
    factory(workbox);
  vm.runInNewContext(fs.readFileSync(filePath, "utf8"), {
    define,
    self: { define, addEventListener: vi.fn(), skipWaiting },
  });
  return { entries, denylist, skipWaiting, clientsClaim };
}

it("precaches revisioned UI images without caching server data or forcing activation", async () => {
  const dir = fs.mkdtempSync(path.join(getTempPathForTesting(), "pwa-"));
  const images = [
    "board/wood.webp",
    "piece/wood/black_pawn.png",
    "stand/wood.webp",
    "icon/menu.svg",
  ];
  const excluded = [
    "assets/unused-abcdefgh.wasm",
    "sound/piece.mp3",
    "puzzles-manifest.json",
    "puzzles/problems.json",
    "api/kifu/private.json",
    "uploads/user.png",
  ];
  for (const name of ["index.html", "assets/main-abcdefgh.js", ...images, ...excluded]) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `fixture for ${name}`);
  }

  vi.stubEnv("NODE_ENV", "production");
  try {
    const config = await resolveConfig(
      { configFile: path.resolve("vite.config-pwa.mts"), build: { outDir: dir } },
      "build",
    );
    const api = config.plugins.find((plugin) => plugin.name === "vite-plugin-pwa")?.api as
      VitePluginPWAAPI | undefined;
    if (!api) throw new Error("PWA plugin missing");
    await api.generateSW();
    const first = inspectWorker(path.join(dir, "sw.js"));
    const urls = first.entries.map((entry) => entry.url);
    expect(urls).toEqual(expect.arrayContaining(["index.html", "assets/main-abcdefgh.js"]));
    for (const image of images) {
      expect(first.entries.find((entry) => entry.url === image)?.revision).toMatch(/^[\da-f]+$/);
    }
    for (const name of excluded) expect(urls).not.toContain(name);
    for (const url of [
      "/api",
      "/api/kifu/private",
      "/board/missing.webp",
      "/sound/missing.mp3",
      "/BOARD/missing.WEBP",
      "/ASSETS/missing",
      "/board?design=wood",
      "/robots.txt",
      "/missing.wasm",
      "/missing.map",
      "/missing.txt",
      "/missing.png",
      "/missing.png?v=1",
      "/nested/missing.txt?path=/some-vue-route",
      "/.hidden",
      "/trailing.",
      "/third-party-licenses.html",
    ]) {
      expect(first.denylist.some((pattern) => pattern.test(url))).toBe(true);
    }
    for (const url of [
      "/",
      "/some-vue-route",
      "/v1.2/some-vue-route",
      "/?usen=~0.7ku&mobile",
      "/some-vue-route?file=/board/missing.png",
    ]) {
      expect(first.denylist.some((pattern) => pattern.test(url))).toBe(false);
    }
    expect(first.skipWaiting).not.toHaveBeenCalled();
    expect(first.clientsClaim).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(dir, images[0]), "replacement image");
    await api.generateSW();
    const updated = inspectWorker(path.join(dir, "sw.js"));
    expect(updated.entries.find((entry) => entry.url === images[0])?.revision).not.toBe(
      first.entries.find((entry) => entry.url === images[0])?.revision,
    );
    expect(updated.entries.find((entry) => entry.url === images[1])?.revision).toBe(
      first.entries.find((entry) => entry.url === images[1])?.revision,
    );

    const largeAsset = "assets/large-abcdefgh.js";
    fs.writeFileSync(path.join(dir, largeAsset), Buffer.alloc(2 * 1024 * 1024, "a"));
    await api.generateSW();
    expect(inspectWorker(path.join(dir, "sw.js")).entries.map((entry) => entry.url)).toContain(
      largeAsset,
    );
    fs.appendFileSync(path.join(dir, largeAsset), "a");
    await expect(api.generateSW()).rejects.toThrow("maximumFileSizeToCacheInBytes");
  } finally {
    vi.unstubAllEnvs();
  }
}, 30_000);
