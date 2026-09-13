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
      },
    },
  },
  test: {
    environment: "node",
  },
});
