import { staticAssetPathPatterns } from "@/common/assets/static";

describe("Static asset paths", () => {
  it.each([
    "/assets/missing",
    "/board",
    "/board?design=wood",
    "/BOARD/missing",
    "/piece/missing",
    "/stand/missing",
    "/icon/missing",
    "/sound/missing",
    "/puzzles/missing",
    "/robots.txt",
    "/missing.wasm",
    "/missing.map",
    "/missing.png",
    "/missing.png?v=1",
    "/nested/missing.txt?path=/some-vue-route",
    "/.hidden",
    "/trailing.",
  ])("excludes %s from SPA fallback", (url) => {
    expect(staticAssetPathPatterns.some((pattern) => pattern.test(url))).toBe(true);
  });

  it.each([
    "/",
    "/some-vue-route",
    "/some-vue-route/",
    "/board-settings",
    "/v1.2/some-vue-route",
    "/?usen=~0.7ku&mobile",
    "/some-vue-route?file=missing.png",
    "/some-vue-route?file=/board/missing.png",
    "/v1.2/some-vue-route?file=/missing.png",
  ])("allows SPA fallback for %s", (url) => {
    expect(staticAssetPathPatterns.some((pattern) => pattern.test(url))).toBe(false);
  });
});
