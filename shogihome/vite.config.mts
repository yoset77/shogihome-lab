/// <reference types="vitest/config" />
import { resolve } from "node:path";
import fs from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const pkg = JSON.parse(fs.readFileSync(resolve(import.meta.dirname, "package.json"), "utf-8"));

export default defineConfig({
  resolve: {
    alias: [{ find: "@", replacement: "/src" }],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [vue()],
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
      },
    },
    outDir: resolve(import.meta.dirname, "dist"),
    chunkSizeWarningLimit: 5000000,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    dir: "./src/tests",
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
    execArgv: parseInt(process.versions.node.split(".")[0], 10) >= 25 ? ["--no-webstorage"] : [],
    coverage: {
      exclude: [
        "docs",
        "plugins",
        "scripts",
        "dist",
        "dev-dist",

        // テストコード
        "src/tests",

        // 設定ファイル
        "vite.config.mts",
        "vite.config-pwa.mts",
        ".*.*",
        "**/*.d.ts",
        "**/*.vue",

        // 定義/設定
        "src/common/control/**/*.ts",
        "src/common/i18n/**/*.ts",

        // IPC
        "src/renderer/ipc/api.ts",
        "src/renderer/ipc/bridge.ts",
        "src/renderer/ipc/web.ts",
        "src/renderer/ipc/setup.ts",

        // UI
        "src/renderer/index.ts",
        "src/renderer/assets/icons.ts",
        "src/renderer/devices/audio.ts",
        "src/renderer/devices/hotkey.ts",
      ],
    },
  },
});
