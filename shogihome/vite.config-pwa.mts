/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import base from "./vite.config.mjs";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  ...base,
  plugins: [
    ...(base.plugins || []),
    VitePWA({
      registerType: "prompt",
      devOptions: {
        enabled: process.env.PWA_DEV === "1",
      },
      manifest: {
        name: "ShogiHome Lab",
        short_name: "ShogiHome Lab",
        description: "将棋の対局や棋譜の編集ができるアプリ",
        background_color: "#888888",
        theme_color: "#888888",
        display: "standalone",
        lang: "ja",
        icons: [{ sizes: "512x512", src: "favicon.png", type: "image/png" }],
      },
      workbox: {
        skipWaiting: false,
        clientsClaim: false,
        navigateFallbackDenylist: [/^\/third-party-licenses/],
      },
    }),
  ],
});
