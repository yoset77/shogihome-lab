import express from "express";
import http from "http";
import net from "net";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import readline from "readline";
import events from "node:events";
import { normalizePath } from "@/common/helpers/path";
import { closeBookSessionForRequest, getBookSession } from "@/server/bookSessionManager";
import { authenticateSocket } from "@/server/engine/auth";
import { engineConfigCache, getEngineList } from "@/server/engine/list";
import {
  EngineState,
  type EngineConfig,
  type EngineHandle,
  type ExtendedWebSocket,
} from "@/server/engine/types";
import { errorHandler, sendError } from "@/server/errors";
import {
  ALLOWED_ORIGINS,
  ANALYSIS_DB_MIN_DEPTH,
  BIND_ADDRESS,
  CONNECTION_PROTECTION_TIMEOUT,
  dataDir,
  ENGINE_STOP_TIMEOUT_MS,
  KIFU_DIR,
  ONTHEFLY_THRESHOLD_MB,
  PORT,
  REMOTE_ENGINE_HOST,
  REMOTE_ENGINE_PORT,
  shogiHomePath,
} from "@/server/config";
import {
  createHelmetMiddleware,
  createRateLimiter,
  isValidHost,
  validateHostHeader,
} from "@/server/security";
import {
  getKifuList,
  getBookList,
  getPositionList,
  resolveKifuPath,
  clearKifuListCache,
  setupKifuWatcher,
} from "@/background/helpers/kifu";
import {
  openBook,
  saveBook,
  clearBook,
  searchBookMoves,
  updateBookMove,
  removeBookMove,
  updateBookMoveOrder,
  importBookMoves,
  isBookOnTheFly,
} from "@/background/book";
import { getNormalizedSfenAndHash } from "@/background/usi/sfen";
import * as kifuIndexDB from "@/background/database/kifu_index";
import * as kifuIndexSync from "@/background/kifu_index/sync";
import { writeFileAtomic, writeFileAtomicSync } from "@/background/file/atomic";
import { fetch as fetchRemote } from "@/background/helpers/http";
import { getHistory, saveBackup, clearHistory, addHistory } from "@/background/file/history";
import {
  initDatabase,
  saveAnalysisResults,
  getAnalysisResults,
  getAnalysisDBStats,
  deleteAnalysisResultsByEngine,
  cleanupAnalysisResults,
  deleteAnalysisResult,
  exportAnalysisResultsByEngine,
  getMigrationSummary,
  executeMigration,
} from "@/background/database/sqlite";
import { parseInfoCommand, USIInfoCommand } from "@/common/game/usi";

export const app = express();
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
  console.log("Trust proxy is ENABLED");
} else {
  app.set("trust proxy", false);
  console.log("Trust proxy is DISABLED");
}
const server = http.createServer(app);
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

updatePuzzlesManifest();

initDatabase(dataDir);
kifuIndexDB.initDatabase(dataDir);

if (KIFU_DIR) {
  kifuIndexSync.syncKifuDirectory(KIFU_DIR);
}

export { EngineState };

app.use(validateHostHeader);
app.use(createHelmetMiddleware());

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  verifyClient: (info, cb) => {
    const origin = info.origin;
    const req = info.req;

    // Check Origin
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      console.warn(`Blocked connection from unauthorized origin: ${origin}`);
      cb(false, 403, "Forbidden");
      return;
    }

    // Check Host header (DNS Rebinding protection)
    if (!isValidHost(req)) {
      console.warn(`Blocked connection with invalid Host header: ${req.headers.host}`);
      cb(false, 403, "Forbidden (Invalid Host)");
      return;
    }

    cb(true);
  },
});

app.use(createRateLimiter());

app.get("/api/kifu/list", async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  if (req.query.reload === "true") {
    clearKifuListCache();
  }
  const list = await getKifuList(KIFU_DIR);

  const dirParam = req.query.dir as string | undefined;
  if (
    dirParam &&
    normalizePath(dirParam)
      .split("/")
      .some((s) => s === "..")
  ) {
    sendError(res, 400, "invalid dir");
    return;
  }
  const entriesMap = new Map<string, { name: string; path: string; isDirectory: boolean }>();
  const currentDirNormalized = dirParam ? normalizePath(dirParam) : "";
  const prefix = currentDirNormalized ? currentDirNormalized + "/" : "";
  const prefixLower = prefix.toLowerCase();

  list.forEach((file) => {
    const fileNormalized = normalizePath(file);
    if (fileNormalized.toLowerCase().startsWith(prefixLower)) {
      const relative = fileNormalized.substring(prefix.length);
      const parts = relative.split("/");
      if (parts.length > 1) {
        const dirName = parts[0];
        const dirPath = prefix + dirName;
        if (!entriesMap.has(dirName)) {
          entriesMap.set(dirName, { name: dirName, path: dirPath, isDirectory: true });
        }
      } else if (parts.length === 1 && parts[0] !== "") {
        const fileName = parts[0];
        entriesMap.set(fileName, { name: fileName, path: fileNormalized, isDirectory: false });
      }
    }
  });

  const responseList = Array.from(entriesMap.values()).sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  res.json(responseList);
});

app.get("/api/kifu/search", async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  let sfen = req.query.sfen as string | undefined;
  let sfenHash: bigint | undefined;
  if (sfen) {
    const normalized = getNormalizedSfenAndHash(sfen);
    if (!normalized) {
      sendError(res, 400, "Invalid sfen");
      return;
    }
    sfen = normalized.sfen;
    sfenHash = normalized.hash;
  }
  if (!sfen) {
    sfenHash = undefined;
  }
  const keyword = req.query.keyword as string | undefined;
  const player1 = req.query.player1 as string | undefined;
  const player2 = req.query.player2 as string | undefined;
  const isStrictTurn = req.query.isStrictTurn === "true";
  const startDate = req.query.startDate as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

  const results = kifuIndexDB.searchKifu({
    sfen,
    sfenHash,
    keyword,
    player1,
    player2,
    isStrictTurn,
    startDate,
    limit,
    offset,
  });
  res.json(results);
});

app.get("/api/kifu/index/status", (req, res) => {
  res.json(kifuIndexSync.getSyncStatus());
});

app.get("/api/kifu/enabled", (req, res) => {
  res.json({ enabled: !!KIFU_DIR });
});

const allowedFetchDomains = new Set(
  (process.env.ALLOWED_FETCH_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== ""),
);

app.get("/api/fetch-remote", async (req, res) => {
  const targetUrl = req.query.url;
  if (typeof targetUrl !== "string") {
    sendError(res, 400, "url is required");
    return;
  }

  const urlObj = new URL(targetUrl);
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    sendError(res, 400, `Unsupported protocol: ${urlObj.protocol}`);
    return;
  }
  if (!allowedFetchDomains.has(urlObj.hostname.toLowerCase())) {
    console.warn(`Blocked remote fetch for unauthorized domain: ${urlObj.hostname}`);
    sendError(
      res,
      403,
      `Forbidden: domain ${urlObj.hostname} is not allowed by ALLOWED_FETCH_DOMAINS.`,
    );
    return;
  }

  const text = await fetchRemote(urlObj.href);
  res.type("text/plain").send(text);
});

app.get("/api/history", async (req, res) => {
  const history = await getHistory();
  res.json(history);
});

app.get("/api/analysis", async (req, res) => {
  const sfen = req.query.sfen;
  if (typeof sfen !== "string") {
    sendError(res, 400, "sfen is required");
    return;
  }

  const parsed = getNormalizedSfenAndHash(sfen);
  if (!parsed) {
    res.json([]);
    return;
  }

  console.log(`Analysis DB Query: sfen=${sfen} hash=${parsed.hash}`);

  const results = getAnalysisResults(parsed.hash, parsed.sfen);
  console.log(`Analysis DB Results: found ${results.length} records`);
  res.json(results);
});

app.get("/api/analysis/stats", async (req, res) => {
  const stats = getAnalysisDBStats();
  res.json(stats);
});

app.post("/api/analysis/delete_by_engine", express.json(), async (req, res) => {
  const engineId = req.body.engineId;
  if (typeof engineId !== "number" || !Number.isInteger(engineId) || engineId <= 0) {
    sendError(res, 400, "engineId must be a positive integer");
    return;
  }
  deleteAnalysisResultsByEngine(engineId);
  res.send("ok");
});

app.post("/api/analysis/cleanup", express.json(), async (req, res) => {
  const minDepth = req.body.minDepth;
  if (typeof minDepth !== "number" || !Number.isInteger(minDepth) || minDepth <= 0) {
    sendError(res, 400, "minDepth must be a positive integer");
    return;
  }
  cleanupAnalysisResults(minDepth);
  res.send("ok");
});

app.post("/api/analysis/delete", express.json(), async (req, res) => {
  const sfen = req.body.sfen;
  const engineId = req.body.engineId;
  const multipv = req.body.multipv;
  if (typeof sfen !== "string") {
    sendError(res, 400, "sfen is required");
    return;
  }
  if (typeof engineId !== "number" || !Number.isInteger(engineId) || engineId <= 0) {
    sendError(res, 400, "engineId must be a positive integer");
    return;
  }
  if (typeof multipv !== "number" || !Number.isInteger(multipv) || multipv < 1) {
    sendError(res, 400, "multipv must be a positive integer");
    return;
  }
  const parsed = getNormalizedSfenAndHash(sfen);
  if (!parsed) {
    sendError(res, 400, "invalid sfen");
    return;
  }
  deleteAnalysisResult(parsed.hash, parsed.sfen, engineId, multipv);
  res.send("ok");
});

app.post("/api/analysis/export", express.json(), async (req, res) => {
  const engineId = req.body.engineId;
  const relPath = req.body.filename as string;
  if (typeof engineId !== "number" || !Number.isInteger(engineId) || engineId <= 0) {
    sendError(res, 400, "engineId must be a positive integer");
    return;
  }
  if (!relPath) {
    sendError(res, 400, "filename is required");
    return;
  }
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }

  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath) {
    sendError(res, 400, "invalid filename");
    return;
  }
  const generator = exportAnalysisResultsByEngine(engineId);
  const stream = fs.createWriteStream(fullPath);

  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.on("finish", resolve);
    (async () => {
      for (const chunk of generator) {
        if (!stream.write(chunk)) {
          await events.once(stream, "drain");
        }
      }
      stream.end();
    })().catch(reject);
  });

  res.send("ok");
});

app.get("/api/analysis/migrate/dry-run", async (req, res) => {
  const keyMapping = new Map<string, string>();
  const nameMapping = new Map<string, string>();
  for (const config of engineConfigCache.values()) {
    if (config.analysisDBGroupId) {
      keyMapping.set(config.id, config.analysisDBGroupId);
      nameMapping.set(config.analysisDBGroupId, config.analysisDBGroupName || config.name);
    }
  }
  const summary = getMigrationSummary(keyMapping, nameMapping);
  res.json(summary);
});

app.post("/api/analysis/migrate/execute", async (req, res) => {
  const keyMapping = new Map<string, string>();
  const nameMapping = new Map<string, string>();
  for (const config of engineConfigCache.values()) {
    if (config.analysisDBGroupId) {
      keyMapping.set(config.id, config.analysisDBGroupId);
      nameMapping.set(config.analysisDBGroupId, config.analysisDBGroupName || config.name);
    }
  }
  try {
    executeMigration(keyMapping, nameMapping);
    res.send("ok");
  } catch (e) {
    console.error("Migration failed:", e);
    res.status(500).send("Migration failed");
  }
});

app.post("/api/history/add", express.json(), async (req, res) => {
  const { path } = req.body;
  if (typeof path !== "string" || !path) {
    sendError(res, 400, "path is required");
    return;
  }
  addHistory(path);
  res.send("ok");
});

app.post("/api/history/backup", express.text({ limit: "10mb" }), async (req, res) => {
  const kif = req.body;
  if (typeof kif !== "string" || !kif) {
    sendError(res, 400, "kif text body is required");
    return;
  }
  await saveBackup(kif);
  res.send("ok");
});

app.post("/api/history/clear", async (req, res) => {
  await clearHistory();
  res.send("ok");
});

app.get("/api/kifu/get", async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  const relPath = req.query.path;
  if (typeof relPath !== "string") {
    sendError(res, 400, "path is required");
    return;
  }
  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath) {
    sendError(res, 403, "forbidden");
    return;
  }
  const data = await fs.promises.readFile(fullPath);
  res.send(data);
});

app.post("/api/kifu/save", express.raw({ limit: "10mb" }), async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  const relPath = req.query.path;
  if (typeof relPath !== "string") {
    sendError(res, 400, "path is required");
    return;
  }
  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath) {
    sendError(res, 403, "forbidden");
    return;
  }
  await writeFileAtomic(fullPath, req.body);
  clearKifuListCache();
  res.send("ok");
});

app.get("/api/sfen/load", async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  const relPath = req.query.path as string;
  if (!relPath) {
    sendError(res, 400, "path is required");
    return;
  }
  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath || !fullPath.endsWith(".sfen")) {
    sendError(res, 403, "Invalid path or unsupported file type");
    return;
  }
  const content = await fs.promises.readFile(fullPath, "utf-8");
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  res.json({ lines });
});

app.post("/api/book/open", express.json(), async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  let relPath = req.query.path;
  if (typeof relPath !== "string") {
    sendError(res, 400, "path is required");
    return;
  }
  if (relPath.startsWith("server://")) {
    relPath = relPath.substring(9);
  }
  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath) {
    sendError(res, 403, "forbidden");
    return;
  }
  const bookSession = getBookSession(req);
  // Override the threshold with the server-side environment variable to protect server memory.
  // Also, explicitly map expected properties to avoid passing unknown fields from req.body.
  const options = {
    forceOnTheFly: req.body?.forceOnTheFly === true,
    onTheFlyThresholdMB: ONTHEFLY_THRESHOLD_MB,
  };
  const mode = await openBook(bookSession, fullPath, options);
  res.json({ mode });
});

app.get("/api/book/list", async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  const list = await getBookList(KIFU_DIR);
  res.json(list);
});

app.get("/api/sfen/list", async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  const list = await getPositionList(KIFU_DIR);
  res.json(list);
});

app.post("/api/book/save", async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  const relPath = req.query.path;
  if (typeof relPath !== "string") {
    sendError(res, 400, "path is required");
    return;
  }
  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath) {
    sendError(res, 403, "forbidden");
    return;
  }
  const bookSession = getBookSession(req);
  await saveBook(bookSession, fullPath);
  res.send("ok");
});

app.post("/api/book/close", async (req, res) => {
  closeBookSessionForRequest(req);
  res.send("ok");
});

app.post("/api/book/clear", async (req, res) => {
  const bookSession = getBookSession(req);
  clearBook(bookSession);
  res.send("ok");
});

app.get("/api/book/search", async (req, res) => {
  const sfen = req.query.sfen;
  if (typeof sfen !== "string") {
    sendError(res, 400, "sfen is required");
    return;
  }
  const bookSession = getBookSession(req);
  const moves = await searchBookMoves(bookSession, sfen);
  res.json(moves);
});

app.post("/api/book/search/batch", express.json({ limit: "10mb" }), async (req, res) => {
  const sfens = req.body.sfens;
  if (!Array.isArray(sfens)) {
    sendError(res, 400, "sfens must be an array");
    return;
  }
  if (sfens.length > 100000) {
    sendError(res, 400, "sfens array is too large (max 100000)");
    return;
  }
  const bookSession = getBookSession(req);
  const results = new Array(sfens.length);
  let nextIndex = 0;
  const maxConcurrency = isBookOnTheFly(bookSession) ? 16 : 1;
  const concurrency = Math.min(sfens.length, maxConcurrency);
  const worker = async () => {
    while (nextIndex < sfens.length) {
      const i = nextIndex++;
      const sfen = sfens[i];
      const moves = await searchBookMoves(bookSession, sfen);
      results[i] = { sfen, moves };
    }
  };
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  res.json(results);
});

app.post("/api/book/update", express.json(), async (req, res) => {
  const sfen = req.query.sfen;
  if (typeof sfen !== "string") {
    sendError(res, 400, "sfen is required");
    return;
  }
  const bookSession = getBookSession(req);
  await updateBookMove(bookSession, sfen, req.body);
  res.send("ok");
});

app.post("/api/book/remove", express.json(), async (req, res) => {
  const sfen = req.query.sfen;
  const usi = req.query.usi;
  if (typeof sfen !== "string" || typeof usi !== "string") {
    sendError(res, 400, "sfen and usi are required");
    return;
  }
  const bookSession = getBookSession(req);
  await removeBookMove(bookSession, sfen, usi);
  res.send("ok");
});

app.post("/api/book/order", express.json(), async (req, res) => {
  const sfen = req.query.sfen;
  const usi = req.query.usi;
  const order = parseInt(req.query.order as string, 10);
  if (typeof sfen !== "string" || typeof usi !== "string" || isNaN(order)) {
    sendError(res, 400, "sfen, usi and order are required");
    return;
  }
  const bookSession = getBookSession(req);
  await updateBookMoveOrder(bookSession, sfen, usi, order);
  res.send("ok");
});

app.post("/api/book/import", express.json(), async (req, res) => {
  if (!KIFU_DIR) {
    sendError(res, 404, "KIFU_DIR is not configured");
    return;
  }
  const settings = {
    sourceType: req.body.sourceType,
    sourceDirectory: req.body.sourceDirectory,
    sourceRecordFile: req.body.sourceRecordFile,
    minPly: Number(req.body.minPly),
    maxPly: Number(req.body.maxPly),
    playerCriteria: req.body.playerCriteria,
    playerName: req.body.playerName,
  };
  if (typeof settings.sourceRecordFile === "string" && settings.sourceRecordFile) {
    if (!settings.sourceRecordFile.startsWith("server://")) {
      sendError(res, 400, "sourceRecordFile must be a server:// URI");
      return;
    }
    const resolved = resolveKifuPath(KIFU_DIR, settings.sourceRecordFile.substring(9));
    if (!resolved) {
      sendError(res, 403, "forbidden sourceRecordFile");
      return;
    }
    settings.sourceRecordFile = resolved;
  }
  if (typeof settings.sourceDirectory === "string" && settings.sourceDirectory) {
    if (!settings.sourceDirectory.startsWith("server://")) {
      sendError(res, 400, "sourceDirectory must be a server:// URI");
      return;
    }
    const resolved = resolveKifuPath(KIFU_DIR, settings.sourceDirectory.substring(9));
    if (!resolved) {
      sendError(res, 403, "forbidden sourceDirectory");
      return;
    }
    settings.sourceDirectory = resolved;
  }
  const bookSession = getBookSession(req);
  const summary = await importBookMoves(bookSession, settings, undefined, KIFU_DIR);
  res.json(summary);
});

app.use(express.static(shogiHomePath));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(shogiHomePath, "index.html"));
});

app.use(errorHandler);

export class EngineSession {
  private currentEngineId: string | null = null;
  private currentEngineConfig: EngineConfig | null = null;
  private engineHandle: EngineHandle | null = null;
  private connectingSocket: net.Socket | null = null;
  private engineState = EngineState.UNINITIALIZED;
  private commandQueue: string[] = [];
  private postStopCommandQueue: string[] = [];
  private stopTimeout: NodeJS.Timeout | null = null;
  private currentEngineSfen: string | null = null;
  private pendingGoSfen: string | null = null;
  private isExplicitlyTerminated = false;
  private ws: ExtendedWebSocket | null = null;
  private cleanupTimeout: NodeJS.Timeout | null = null;
  private messageBuffer: { data: unknown; createdAt: number }[] = [];
  private lastInfos = new Map<number, USIInfoCommand>();

  private readonly MAX_QUEUE_SIZE = 100;

  constructor(public readonly sessionId: string) {}

  private pushToQueue(queue: string[], command: string) {
    if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
      return;
    }
    queue.push(command);
    if (queue.length > this.MAX_QUEUE_SIZE) {
      queue.shift();
    }
  }

  attach(ws: ExtendedWebSocket) {
    console.log(`Attaching session ${this.sessionId} to new WebSocket`);
    this.clearCleanupTimeout();

    if (this.ws) {
      try {
        console.log(`Terminating replaced socket for session ${this.sessionId}`);
        this.ws.terminate();
      } catch {
        // ignore
      }
    }

    this.ws = ws;
    this.isExplicitlyTerminated = false;

    ws.on("message", (message) => this.handleMessage(message.toString()));
    ws.on("close", () => this.handleDisconnect(ws));

    // Send initial state to client
    this.sendState();

    // Replay buffered messages
    console.log(
      `Replaying ${this.messageBuffer.length} buffered messages for session ${this.sessionId}`,
    );
    while (this.messageBuffer.length > 0) {
      const { data, createdAt } = this.messageBuffer.shift()!;
      this.sendToClient(data, createdAt);
    }
  }

  private sendState() {
    let stateStr = "uninitialized";
    switch (this.engineState) {
      case EngineState.STARTING:
      case EngineState.WAITING_USIOK:
      case EngineState.WAITING_READYOK:
        stateStr = "starting";
        break;
      case EngineState.THINKING:
      case EngineState.STOPPING_SEARCH:
        stateStr = "thinking";
        break;
      case EngineState.READY:
        stateStr = "ready";
        break;
      case EngineState.TERMINATING:
      case EngineState.STOPPED:
        stateStr = "stopped";
        break;
    }
    this.sendToClient({ state: stateStr });
  }

  private handleDisconnect(socket: ExtendedWebSocket) {
    if (this.ws !== socket) {
      console.log(`Ignoring disconnect for session ${this.sessionId} (socket replaced)`);
      return;
    }

    console.log(`WebSocket disconnected for session ${this.sessionId}`);
    this.ws = null;

    if (
      this.isExplicitlyTerminated ||
      this.sessionId.startsWith("discovery-") ||
      this.engineState === EngineState.UNINITIALIZED
    ) {
      this.terminate();
    } else {
      console.log(
        `Session ${this.sessionId} entered disconnection protection (${CONNECTION_PROTECTION_TIMEOUT}ms)`,
      );
      this.cleanupTimeout = setTimeout(() => {
        console.log(`Session ${this.sessionId} protection timed out. Terminating.`);
        this.terminate();
      }, CONNECTION_PROTECTION_TIMEOUT);
    }
  }

  private clearCleanupTimeout() {
    if (this.cleanupTimeout) {
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }
  }

  private terminate() {
    this.clearCleanupTimeout();
    this.messageBuffer = [];
    this.lastInfos.clear();
    if (this.connectingSocket) {
      this.connectingSocket.destroy();
      this.connectingSocket = null;
    }
    if (this.engineHandle && this.engineState !== EngineState.TERMINATING) {
      this.engineState = EngineState.TERMINATING;
      this.engineHandle.close();
    } else {
      this.onEngineClose();
    }
    sessionManager.removeSession(this.sessionId);
  }

  private sendToClient(data: unknown, createdAt: number = Date.now()) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (typeof data === "object" && data !== null) {
        const delay = Date.now() - createdAt;
        // Clone object to avoid side effects if strictly necessary, but here we construct fresh objects mostly
        this.ws.send(JSON.stringify({ ...data, delay }));
      } else {
        this.ws.send(JSON.stringify(data));
      }
    } else {
      // Buffer messages during disconnection
      // For 'info' messages, we only keep the latest few to avoid memory issues
      if (typeof data === "object" && data !== null && "info" in data) {
        const info = (data as { info: string }).info;
        if (info.startsWith("info")) {
          // Keep only the last 10 info messages if disconnected
          const infoCount = this.messageBuffer.filter(
            (m) =>
              typeof m.data === "object" &&
              m.data !== null &&
              "info" in m.data &&
              (m.data as { info: string }).info.startsWith("info"),
          ).length;
          if (infoCount >= 10) {
            const firstInfoIndex = this.messageBuffer.findIndex(
              (m) =>
                typeof m.data === "object" &&
                m.data !== null &&
                "info" in m.data &&
                (m.data as { info: string }).info.startsWith("info"),
            );
            if (firstInfoIndex !== -1) {
              this.messageBuffer.splice(firstInfoIndex, 1);
            }
          }
        }
      }
      this.messageBuffer.push({ data, createdAt });
    }
  }

  private sendError(message: string) {
    let safeMessage = message;
    if (message.includes("WRAPPER_ERROR:")) {
      console.error(`Internal Wrapper Error: ${message}`);
      if (message.includes("Engine executable not found")) {
        safeMessage = "error: Engine executable not found.";
      } else if (message.includes("Engine path for type")) {
        safeMessage = "error: Engine path configuration error.";
      } else {
        safeMessage = "error: Internal server error.";
      }
    } else {
      safeMessage = message.startsWith("error: ") ? message : `error: ${message}`;
    }
    this.sendToClient({ error: safeMessage });
  }

  private isValidUsiCommand(command: string): boolean {
    if (/[\r\n]/.test(command)) return false;

    const cmd = command.trim();
    if (cmd === "") return false;
    const parts = cmd.split(" ");
    const head = parts[0];

    switch (head) {
      case "usi":
      case "isready":
      case "usinewgame":
      case "stop":
      case "ponderhit":
      case "quit":
        return parts.length === 1;
      case "gameover":
        return parts.length === 2 && ["win", "lose", "draw"].includes(parts[1]);
      case "setoption":
        // Restrict to MultiPV to prevent path traversal or resource exhaustion
        return /^setoption name MultiPV value \d+$/.test(cmd);
      case "position":
        if (parts[1] === "startpos") {
          if (parts.length === 2) return true;
          if (parts[2] === "moves") {
            return parts.slice(3).every((m) => /^[a-zA-Z0-9+*]+$/.test(m));
          }
          return false;
        } else if (parts[1] === "sfen") {
          const movesIndex = parts.indexOf("moves");
          if (movesIndex === -1) {
            return new RegExp("^position sfen [a-zA-Z0-9+/ -]+$").test(cmd);
          } else {
            const sfenPart = parts.slice(0, movesIndex).join(" ");
            if (!new RegExp("^position sfen [a-zA-Z0-9+/ -]+$").test(sfenPart)) return false;
            return parts.slice(movesIndex + 1).every((m) => /^[a-zA-Z0-9+*]+$/.test(m));
          }
        }
        return false;
      case "go": {
        const args = parts.slice(1);
        for (let i = 0; i < args.length; i++) {
          const t = args[i];
          if (["ponder", "infinite"].includes(t)) continue;
          if (t === "mate") {
            // go mate / go mate infinite / go mate <milliseconds> をすべて受け入れる
            if (i + 1 < args.length && /^(\d+|infinite)$/.test(args[i + 1])) {
              i++;
            }
            continue;
          }
          if (["btime", "wtime", "byoyomi", "binc", "winc"].includes(t)) {
            if (i + 1 >= args.length || !/^-?\d+$/.test(args[i + 1])) return false;
            i++;
          } else {
            return false;
          }
        }
        return true;
      }
      default:
        return false;
    }
  }

  private sendToEngine(command: string) {
    if (this.engineHandle) {
      if (!this.isValidUsiCommand(command)) {
        console.warn(`Invalid USI command blocked: ${command}`);
        return;
      }

      if (command.startsWith("position ")) {
        this.currentEngineSfen = command;
      }
      if (command.startsWith("go")) {
        this.engineState = EngineState.THINKING;
        this.pendingGoSfen = this.currentEngineSfen;
        this.sendState();
      }
      console.log(`Sending to engine (${this.sessionId}): ${command}`);
      this.engineHandle.write(command + "\n");
    }
  }

  private onEngineClose() {
    if (
      this.engineState === EngineState.STOPPED ||
      this.engineState === EngineState.UNINITIALIZED ||
      this.sessionId.startsWith("discovery-")
    ) {
      return;
    }
    console.log(`Engine process exited for session ${this.sessionId}.`);
    if (this.engineHandle) {
      this.engineHandle.removeAllListeners();
      this.engineHandle = null;
    }
    this.currentEngineId = null;
    this.currentEngineConfig = null;
    this.engineState = EngineState.STOPPED;
    this.commandQueue.length = 0;
    this.postStopCommandQueue.length = 0;
    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }
    this.currentEngineSfen = null;
    this.pendingGoSfen = null;
    this.lastInfos.clear();
    this.sendState();
    this.sendToClient({ info: "info: engine stopped" });
  }

  private setupEngineHandlers(stream: NodeJS.ReadableStream, rl?: readline.Interface) {
    const interface_ = rl || readline.createInterface({ input: stream });
    interface_.on("line", (line) => {
      if (!line.startsWith("info")) {
        console.log(`Engine output (${this.sessionId}): ${line}`);
      }

      if (line.startsWith("info ")) {
        const parsed = parseInfoCommand(line.substring(5));
        if (parsed.depth !== undefined && !parsed.lowerbound && !parsed.upperbound) {
          const pvId = parsed.multipv || 1;
          const currentInfo = this.lastInfos.get(pvId) || {};
          // Merge with previous to keep nodes/time if omitted in this line
          this.lastInfos.set(pvId, { ...currentInfo, ...parsed });
        }
      }

      if (line.trim().startsWith("WRAPPER_ERROR:")) {
        console.error(`Engine wrapper error: ${line}`);
        this.sendError(line);
        this.terminate();
        return;
      }

      this.sendToClient({ sfen: this.pendingGoSfen, info: line });

      if (line.startsWith("bestmove") || line.startsWith("checkmate")) {
        if (
          line.startsWith("bestmove") &&
          this.currentEngineConfig &&
          !this.currentEngineConfig.skipAnalysisDB &&
          this.pendingGoSfen &&
          this.lastInfos.size > 0
        ) {
          const validInfos = new Map<number, USIInfoCommand>();
          for (const [multipv, info] of this.lastInfos.entries()) {
            if (info.depth !== undefined && info.depth >= ANALYSIS_DB_MIN_DEPTH) {
              validInfos.set(multipv, info);
            }
          }

          if (validInfos.size > 0) {
            const parsedSfen = getNormalizedSfenAndHash(this.pendingGoSfen);
            if (parsedSfen) {
              const engineKey =
                this.currentEngineConfig.analysisDBGroupId || this.currentEngineConfig.id;
              const engineName =
                this.currentEngineConfig.analysisDBGroupName || this.currentEngineConfig.name;
              saveAnalysisResults(
                parsedSfen.hash,
                parsedSfen.sfen,
                engineKey,
                engineName,
                validInfos,
              );
            }
          }
        }
        this.lastInfos.clear();

        if (this.engineState === EngineState.TERMINATING) {
          return;
        }

        if (this.engineState === EngineState.STOPPING_SEARCH) {
          if (this.stopTimeout) {
            clearTimeout(this.stopTimeout);
            this.stopTimeout = null;
          }

          // Filter and collect commands to replay.
          // Resend all commands after the last usinewgame in order,
          // keeping only the latest 1 of each same type.
          const commandsToRun: string[] = [];
          const seenKinds = new Set<string>();

          for (let i = this.postStopCommandQueue.length - 1; i >= 0; i--) {
            const cmd = this.postStopCommandQueue[i];

            let kind = "";
            if (cmd.startsWith("setoption name MultiPV")) {
              kind = "setoption:multipv";
            } else if (cmd.startsWith("position")) {
              kind = "position";
            } else if (cmd.startsWith("go")) {
              kind = "go";
            } else if (cmd.startsWith("gameover")) {
              kind = "gameover";
            } else if (cmd === "usinewgame") {
              kind = "usinewgame";
            } else {
              kind = `other:${cmd}`;
            }

            if (!seenKinds.has(kind)) {
              seenKinds.add(kind);
              commandsToRun.unshift(cmd);
            }

            if (kind === "usinewgame") {
              break;
            }
          }

          this.postStopCommandQueue.length = 0;
          this.engineState = EngineState.READY;
          this.sendState();

          if (commandsToRun.length > 0) {
            for (const command of commandsToRun) {
              this.sendToEngine(command);
            }
          }
        } else {
          this.engineState = EngineState.READY;
          this.sendState();
        }
      }

      if (this.engineState === EngineState.WAITING_USIOK && line.trim() === "usiok") {
        this.engineState = EngineState.WAITING_READYOK;
        this.sendToEngine("isready");
      } else if (this.engineState === EngineState.WAITING_READYOK && line.trim() === "readyok") {
        this.engineState = EngineState.READY;
        this.sendState();
        this.sendToClient({ info: "info: engine is ready" });
        while (this.commandQueue.length > 0) {
          const command = this.commandQueue.shift();
          if (command) this.sendToEngine(command);
        }
      }
    });
  }

  private startEngine(engineId: string) {
    if (this.engineHandle || this.engineState === EngineState.STARTING) {
      this.sendError("engine already running or starting");
      return;
    }
    this.engineState = EngineState.STARTING;
    this.currentEngineId = engineId;
    this.currentEngineConfig = engineConfigCache.get(engineId) || { id: engineId, name: engineId };

    console.log(`Connecting to remote engine at ${REMOTE_ENGINE_HOST}:${REMOTE_ENGINE_PORT}`);
    const socket = new net.Socket();
    this.connectingSocket = socket;

    const connectionTimeout = setTimeout(() => {
      console.error("Connection timed out after 5 seconds");
      this.sendError("connection timed out");
      socket.destroy();
      this.connectingSocket = null;
      this.onEngineClose();
    }, 5000);

    socket.on("connect", async () => {
      clearTimeout(connectionTimeout);
      if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
        socket.destroy();
        return;
      }
      console.log(`Connected to remote engine. Specifying engine ID: ${engineId}`);

      const accessToken = process.env.WRAPPER_ACCESS_TOKEN;

      const setup = (rl?: readline.Interface) => {
        if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
          socket.destroy();
          return;
        }

        this.connectingSocket = null;
        socket.write(`run ${engineId}\n`);

        this.engineState = EngineState.WAITING_USIOK;
        this.engineHandle = {
          write: (cmd) => socket.write(cmd),
          close: () => socket.end(),
          on: (e, l) => socket.on(e, l),
          off: (e, l) => socket.off(e, l),
          removeAllListeners: (e) => socket.removeAllListeners(e),
        };
        this.setupEngineHandlers(socket, rl);
        this.engineHandle.on("close", () => this.onEngineClose());
        this.engineHandle.on("error", (err) => {
          console.error("Remote engine connection error:", err);
          this.sendError("remote engine connection failed");
          this.onEngineClose();
        });
        this.sendToEngine("usi");
      };

      if (accessToken) {
        try {
          const rl = await authenticateSocket(socket, accessToken);
          setup(rl);
        } catch (err: unknown) {
          if (this.isExplicitlyTerminated) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Authentication failed: ${message}`);
          this.sendError(message);
          socket.destroy();
          this.onEngineClose();
        }
      } else {
        setup();
      }
    });

    socket.on("close", () => {
      clearTimeout(connectionTimeout);
      if (this.connectingSocket === socket) this.connectingSocket = null;
    });

    socket.on("error", (err) => {
      clearTimeout(connectionTimeout);
      if (this.connectingSocket === socket) this.connectingSocket = null;
      if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
        return;
      }
      if (this.engineState === EngineState.STARTING) {
        console.error("Failed to connect to remote engine:", err);
        this.sendError(`failed to connect to remote engine (${err.message})`);
        this.onEngineClose();
      }
    });

    socket.connect(REMOTE_ENGINE_PORT, REMOTE_ENGINE_HOST);
  }

  private handleMessage(command: string) {
    if (this.isExplicitlyTerminated || this.engineState === EngineState.TERMINATING) {
      return;
    }
    console.log(`Received command (${this.sessionId}): ${command}`);

    if (command === "get_engine_list") {
      if (this.ws) {
        getEngineList(this.ws);
      }
      return;
    }

    if (command === "ping") {
      this.sendToClient({ info: "pong" });
      return;
    }

    const handleStop = () => {
      if (this.engineState === EngineState.STOPPING_SEARCH) return;
      if (this.engineState === EngineState.THINKING) {
        this.engineState = EngineState.STOPPING_SEARCH;
        this.postStopCommandQueue.length = 0;
        this.sendToEngine("stop");
        if (this.stopTimeout) clearTimeout(this.stopTimeout);
        this.stopTimeout = setTimeout(() => {
          if (this.engineState === EngineState.STOPPING_SEARCH) {
            console.error(
              `Engine for session ${this.sessionId} did not respond to stop command within ${ENGINE_STOP_TIMEOUT_MS}ms. Resetting engine session.`,
            );
            this.sendError("Engine did not respond to stop command. Session reset.");
            if (this.engineHandle) {
              this.engineState = EngineState.TERMINATING;
              this.engineHandle.close();
            }
          }
        }, ENGINE_STOP_TIMEOUT_MS);
      }
    };

    if (command === "stop") {
      handleStop();
      return;
    }

    if (command === "quit") {
      this.isExplicitlyTerminated = true;
      this.sendToEngine(command);
      return;
    }

    if (
      this.engineState === EngineState.THINKING &&
      (command.startsWith("position") ||
        command.startsWith("go") ||
        command.startsWith("setoption") ||
        command.startsWith("gameover") ||
        command === "usinewgame")
    ) {
      console.warn(`Implicitly stopping engine for session ${this.sessionId}`);
      handleStop();
    }

    if (command.startsWith("start_engine ")) {
      const engineId = command.substring("start_engine ".length).trim();
      if (!/^[a-zA-Z0-9_\-.]+$/.test(engineId)) {
        this.sendError("invalid engine id");
        return;
      }
      if (
        this.currentEngineId === engineId &&
        (this.engineHandle || this.engineState === EngineState.STARTING)
      ) {
        console.log(
          `Engine ${engineId} is already active or starting for session ${this.sessionId}. Ignoring redundant start request.`,
        );
        this.sendState();
        return;
      }
      if (this.engineHandle || this.engineState === EngineState.STARTING) {
        this.sendError("engine already running or starting");
        return;
      }
      this.startEngine(engineId);
      return;
    }

    if (command === "stop_engine") {
      const hasActiveEngineSession =
        this.connectingSocket ||
        this.engineHandle ||
        (this.engineState !== EngineState.UNINITIALIZED &&
          this.engineState !== EngineState.STOPPED);
      this.isExplicitlyTerminated = true;
      if (!hasActiveEngineSession) {
        return;
      }
      this.engineState = EngineState.TERMINATING;
      this.currentEngineId = null;
      this.commandQueue.length = 0;
      this.postStopCommandQueue.length = 0;
      if (this.stopTimeout) {
        clearTimeout(this.stopTimeout);
        this.stopTimeout = null;
      }
      this.currentEngineSfen = null;
      this.pendingGoSfen = null;
      this.lastInfos.clear();
      if (this.connectingSocket) {
        this.connectingSocket.destroy();
        this.connectingSocket = null;
        this.onEngineClose();
        return;
      }
      if (this.engineHandle) {
        this.engineHandle.close();
      } else {
        this.onEngineClose();
      }
      return;
    }

    if (this.engineState === EngineState.STOPPING_SEARCH) {
      if (command !== "stop") this.pushToQueue(this.postStopCommandQueue, command);
      return;
    }

    if (command === "usi" || command === "isready") return;

    if (command.startsWith("setoption ")) {
      if (this.engineState >= EngineState.READY) {
        this.sendToEngine(command);
      } else {
        this.pushToQueue(this.commandQueue, command);
      }
      return;
    }

    if (command === "usinewgame" || command.startsWith("gameover")) {
      if (this.engineState === EngineState.READY) {
        this.sendToEngine(command);
      } else {
        this.pushToQueue(this.commandQueue, command);
      }
      return;
    }

    if (this.engineState === EngineState.READY || this.engineState === EngineState.THINKING) {
      this.sendToEngine(command);
    } else if (
      this.engineState > EngineState.UNINITIALIZED &&
      this.engineState < EngineState.READY
    ) {
      this.pushToQueue(this.commandQueue, command);
    } else {
      this.sendError(`engine not started. Cannot process command: ${command}`);
    }
  }
}

class SessionManager {
  private sessions = new Map<string, EngineSession>();
  private readonly MAX_SESSIONS = 50;

  getOrCreateSession(sessionId: string): EngineSession | null {
    let session = this.sessions.get(sessionId);
    if (!session) {
      if (this.sessions.size >= this.MAX_SESSIONS) {
        console.warn(
          `Session limit reached (${this.MAX_SESSIONS}), rejecting new session: ${sessionId.substring(0, 8)}...`,
        );
        return null;
      }
      console.log(`Creating new session: ${sessionId}`);
      session = new EngineSession(sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }
}

const sessionManager = new SessionManager();

// Add a keep-alive mechanism
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws: ExtendedWebSocket) {
    if (ws.isAlive === false) {
      console.log("Client connection timed out, terminating.");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);
interval.unref();

wss.on("close", function close() {
  clearInterval(interval);
});

wss.on("connection", (ws: ExtendedWebSocket, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

  if (!sessionId) {
    console.warn("Connection attempt without sessionId. Closing.");
    ws.close(1008, "sessionId required");
    return;
  }

  if (!SESSION_ID_REGEX.test(sessionId)) {
    console.warn(
      `Blocked connection attempt with invalid sessionId format: ${sessionId.substring(0, 32)}`,
    );
    ws.close(1008, "Invalid sessionId format");
    return;
  }

  const session = sessionManager.getOrCreateSession(sessionId);
  if (!session) {
    ws.close(1013, "Session limit reached");
    return;
  }
  session.attach(ws);
});

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
