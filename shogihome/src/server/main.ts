import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import http from "http";
import fs from "fs";
import path from "path";
import { EngineSession } from "@/server/engine/session";
import { SessionManager } from "@/server/engine/sessionManager";
import { EngineState } from "@/server/engine/types";
import { BIND_ADDRESS, dataDir, KIFU_DIR, PORT, shogiHomePath } from "@/server/config";
import { handleError } from "@/server/errors";
import type { AppEnv } from "@/server/hono";
import {
  createRateLimiter,
  createSecureHeadersMiddleware,
  validateHostHeader,
} from "@/server/security";
import { setupKifuWatcher } from "@/server/helpers/kifu";
import * as kifuIndexDB from "@/server/database/kifu_index";
import * as kifuIndexSync from "@/server/kifu_index/sync";
import { writeFileAtomicSync } from "@/server/file/atomic";
import { initDatabase } from "@/server/database/sqlite";
import { registerAnalysisRoutes } from "@/server/routes/analysis";
import { registerBookRoutes } from "@/server/routes/book";
import { registerFetchRemoteRoute } from "@/server/routes/fetchRemote";
import { registerHistoryRoutes } from "@/server/routes/history";
import { registerKifuRoutes } from "@/server/routes/kifu";
import { registerStaticRoutes } from "@/server/routes/static";
import { registerVisionRoutes } from "@/server/routes/vision";
import { createEngineWebSocketServer } from "@/server/websocket";

export const app = new Hono<AppEnv>();
if (process.env.TRUST_PROXY === "true") {
  console.log("Trust proxy is ENABLED");
} else {
  console.log("Trust proxy is DISABLED");
}
const server = http.createServer(getRequestListener(app.fetch));
server.timeout = 900000;

console.log(`Serving static files from: ${shogiHomePath}`);

const updatePuzzlesManifest = () => {
  const puzzlesDir = path.join(shogiHomePath, "puzzles");
  const manifestPath = path.join(shogiHomePath, "puzzles-manifest.json");
  console.log(`Checking puzzles in: ${puzzlesDir}`);

  try {
    if (!fs.existsSync(puzzlesDir)) {
      console.log("Puzzles directory not found, skipping manifest update.");
      return;
    }

    const files = fs.readdirSync(puzzlesDir).filter((file) => file.endsWith(".json"));
    console.log(`Found ${files.length} puzzle files.`);

    const manifest = files.map((file) => {
      const filePath = path.join(puzzlesDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const puzzles = JSON.parse(content);
        return {
          file: file,
          count: Array.isArray(puzzles) ? puzzles.length : 0,
        };
      } catch (e) {
        console.warn(`Failed to read or parse puzzle file: ${file}`, e);
        return { file: file, count: 0 };
      }
    });

    writeFileAtomicSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`Updated puzzle manifest at ${manifestPath}`);
  } catch (error) {
    console.error("Failed to update puzzle manifest:", error);
  }
};

export { EngineSession, EngineState };

app.use("*", validateHostHeader);
app.use("*", createSecureHeadersMiddleware());

app.use("*", createRateLimiter());
registerKifuRoutes(app);
registerFetchRemoteRoute(app);
registerHistoryRoutes(app);
registerAnalysisRoutes(app);
registerBookRoutes(app);
registerVisionRoutes(app);
registerStaticRoutes(app);
app.onError(handleError);

const sessionManager = new SessionManager<EngineSession>(
  (sessionId) => new EngineSession(sessionId, (id) => sessionManager.removeSession(id)),
);
createEngineWebSocketServer(server, sessionManager);

let isServerInitialized = false;

export const initializeServer = () => {
  if (isServerInitialized) {
    return;
  }
  updatePuzzlesManifest();
  initDatabase(dataDir);
  kifuIndexDB.initDatabase(dataDir);
  if (KIFU_DIR) {
    kifuIndexSync.syncKifuDirectory(KIFU_DIR);
  }
  isServerInitialized = true;
};

const isServerEntryPoint = (entryPath: string | undefined) => {
  if (!entryPath) {
    return false;
  }
  // テストランナー（vitest等）経由の場合は false
  if (entryPath.includes("vitest")) {
    return false;
  }
  // ファイル名がサーバー実行用のものであれば true とする
  const basename = path.basename(entryPath);
  return [
    "server.ts",
    "server.js",
    "server.cjs",
    "server.mjs",
    "shogihome-server.exe",
    "shogihome-server",
  ].includes(basename);
};

export const startServer = () => {
  initializeServer();
  if (KIFU_DIR) {
    const kifuDir = KIFU_DIR;
    console.log(`Server-side kifu directory: ${kifuDir}`);
    setupKifuWatcher(kifuDir, process.env.KIFU_DIR_USE_POLLING === "true", (event, relPath) => {
      kifuIndexSync.onKifuFileEvent(event, kifuDir, relPath);
    });
  }
  server.listen(PORT, BIND_ADDRESS, () => {
    console.log(`Server is listening on ${BIND_ADDRESS}:${PORT}`);
    console.log(`Access ShogiHome at http://localhost:${PORT}`);
  });
};

export const startIfExecutedDirectly = (entryPath: string | undefined) => {
  if (isServerEntryPoint(entryPath)) {
    startServer();
  }
};
