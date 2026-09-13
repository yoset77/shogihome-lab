import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: "src/index.html",
        editor: "src/editor.html",
      },
    },
  },
  test: {
    environment: "node",
  },
});
