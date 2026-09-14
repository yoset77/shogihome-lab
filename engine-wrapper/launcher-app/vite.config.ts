import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: "index.html",
        editor: "editor.html",
        settings: "settings.html",
        logs: "logs.html",
      },
    },
  },
  test: {
    environment: "node",
  },
});
