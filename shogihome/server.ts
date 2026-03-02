import express from "express";
import http from "http";
import net from "net";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { getLocalIpAddresses } from "./src/background/helpers/ip";
import {
  getKifuList,
  getBookList,
  resolveKifuPath,
  clearKifuListCache,
  setupKifuWatcher,
} from "./src/background/helpers/kifu";
import {
  openBook,
  saveBook,
  clearBook,
  searchBookMoves,
  updateBookMove,
  removeBookMove,
  updateBookMoveOrder,
  importBookMoves,
} from "./src/background/book/index";
import { defaultBookSession } from "./src/common/book";
import { writeFileAtomic, writeFileAtomicSync } from "./src/background/file/atomic";

const getBasePath = () => {
  // SEA (Single Executable Application) environment check
  if (path.basename(process.execPath) === "shogihome-server.exe") {
    return path.dirname(process.execPath);
  }
  const __filename = fileURLToPath(import.meta.url);
  return path.dirname(__filename);
};

dotenv.config({ path: path.join(getBasePath(), ".env") });

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
server.timeout = 900000;

const PORT = parseInt(process.env.PORT || "8140", 10);
const DISABLE_AUTO_ALLOWED_ORIGINS = process.env.DISABLE_AUTO_ALLOWED_ORIGINS === "true";

// Build ALLOWED_ORIGINS
const rawAllowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter((origin) => origin.length > 0);

const ALLOWED_ORIGINS: string[] = [];
const ALLOWED_HOSTS = new Set<string>();

if (DISABLE_AUTO_ALLOWED_ORIGINS) {
  // Strict mode: Only use user-defined origins
  rawAllowedOrigins.forEach((origin) => ALLOWED_ORIGINS.push(origin));
} else {
  // Default mode: Add User defined + Localhost + Auto-detected IPs
  const defaults = [...rawAllowedOrigins, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];

  // Deduplicate
  defaults.forEach((origin) => {
    if (!ALLOWED_ORIGINS.includes(origin)) ALLOWED_ORIGINS.push(origin);
  });

  const localIps = getLocalIpAddresses();
  console.log("Auto-detected local IPs:", localIps);

  localIps.forEach((ip) => {
    const origin = `http://${ip}:${PORT}`;
    if (!ALLOWED_ORIGINS.includes(origin)) {
      ALLOWED_ORIGINS.push(origin);
    }
  });
}

// Populate ALLOWED_HOSTS based on final ALLOWED_ORIGINS
ALLOWED_ORIGINS.forEach((origin) => {
  try {
    const url = new URL(origin);
    ALLOWED_HOSTS.add(url.host);
  } catch (e) {
    // ignore invalid URLs
  }
});

console.log("Allowed Origins:", ALLOWED_ORIGINS);

const shogiHomePath = path.join(getBasePath(), "docs", "webapp");
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

const KIFU_DIR = process.env.KIFU_DIR ? path.resolve(getBasePath(), process.env.KIFU_DIR) : null;
if (KIFU_DIR) {
  console.log(`Server-side kifu directory: ${KIFU_DIR}`);
  setupKifuWatcher(KIFU_DIR, process.env.KIFU_DIR_USE_POLLING === "true");
}

// Verify Host header to prevent DNS Rebinding attacks
const isValidHost = (req: http.IncomingMessage) => {
  const host = req.headers.host;
  return host && ALLOWED_HOSTS.has(host);
};

// Middleware to enforce Host header validation for HTTP requests
app.use((req, res, next) => {
  if (!isValidHost(req)) {
    console.warn(`Blocked HTTP request with invalid Host header: ${req.headers.host}`);
    res.status(403).send("Forbidden (Invalid Host)");
    return;
  }
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: [
          "'self'",
          "ws:",
          "wss:",
          ...ALLOWED_ORIGINS.map((o) => o.replace("http", "ws").replace("https", "wss")),
        ],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
      },
    },
    hsts: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  }),
);

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

const REMOTE_ENGINE_HOST = process.env.REMOTE_ENGINE_HOST || "localhost";
const REMOTE_ENGINE_PORT = parseInt(process.env.REMOTE_ENGINE_PORT || "4082", 10);
const CONNECTION_PROTECTION_TIMEOUT =
  parseInt(process.env.ENGINE_CONNECTION_PROTECTION_TIMEOUT || "60", 10) * 1000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3000, // Limit each IP to 3000 requests per windowMs
});

app.use(limiter);

app.get("/api/kifu/list", async (req, res) => {
  if (!KIFU_DIR) {
    res.status(404).send("KIFU_DIR is not configured");
    return;
  }
  try {
    if (req.query.reload === "true") {
      clearKifuListCache();
    }
    const list = await getKifuList(KIFU_DIR);
    res.json(list);
  } catch (e) {
    console.error("failed to get kifu list:", e);
    res.status(500).send("failed to get kifu list");
  }
});

app.get("/api/kifu/enabled", (req, res) => {
  res.json({ enabled: !!KIFU_DIR });
});

app.get("/api/kifu/get", async (req, res) => {
  if (!KIFU_DIR) {
    res.status(404).send("KIFU_DIR is not configured");
    return;
  }
  const relPath = req.query.path;
  if (typeof relPath !== "string") {
    res.status(400).send("path is required");
    return;
  }
  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath) {
    res.status(403).send("forbidden");
    return;
  }
  try {
    const data = await fs.promises.readFile(fullPath);
    res.send(data);
  } catch (e) {
    console.error("failed to fetch kifu:", e);
    res.status(500).send("failed to fetch kifu");
  }
});

app.post("/api/kifu/save", express.raw({ limit: "10mb" }), async (req, res) => {
  if (!KIFU_DIR) {
    res.status(404).send("KIFU_DIR is not configured");
    return;
  }
  const relPath = req.query.path;
  if (typeof relPath !== "string") {
    res.status(400).send("path is required");
    return;
  }
  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath) {
    res.status(403).send("forbidden");
    return;
  }
  try {
    await writeFileAtomic(fullPath, req.body);
    clearKifuListCache();
    res.send("ok");
  } catch (e) {
    console.error("failed to save kifu:", e);
    res.status(500).send("failed to save kifu");
  }
});

app.post("/api/book/open", express.json(), async (req, res) => {
  if (!KIFU_DIR) {
    res.status(404).send("KIFU_DIR is not configured");
    return;
  }
  const relPath = req.query.path;
  if (typeof relPath !== "string") {
    res.status(400).send("path is required");
    return;
  }
  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath) {
    res.status(403).send("forbidden");
    return;
  }
  try {
    const mode = await openBook(defaultBookSession, fullPath, req.body);
    res.json({ mode });
  } catch (e) {
    console.error("failed to open book:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to open book");
  }
});

app.get("/api/book/list", async (req, res) => {
  if (!KIFU_DIR) {
    res.status(404).send("KIFU_DIR is not configured");
    return;
  }
  try {
    const list = await getBookList(KIFU_DIR);
    res.json(list);
  } catch (e) {
    console.error("failed to get book list:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to get book list");
  }
});

app.post("/api/book/save", async (req, res) => {
  if (!KIFU_DIR) {
    res.status(404).send("KIFU_DIR is not configured");
    return;
  }
  const relPath = req.query.path;
  if (typeof relPath !== "string") {
    res.status(400).send("path is required");
    return;
  }
  const fullPath = resolveKifuPath(KIFU_DIR, relPath);
  if (!fullPath) {
    res.status(403).send("forbidden");
    return;
  }
  try {
    await saveBook(defaultBookSession, fullPath);
    res.send("ok");
  } catch (e) {
    console.error("failed to save book:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to save book");
  }
});

app.post("/api/book/clear", async (req, res) => {
  try {
    clearBook(defaultBookSession);
    res.send("ok");
  } catch (e) {
    console.error("failed to clear book:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to clear book");
  }
});

app.get("/api/book/search", async (req, res) => {
  const sfen = req.query.sfen;
  if (typeof sfen !== "string") {
    res.status(400).send("sfen is required");
    return;
  }
  try {
    const moves = await searchBookMoves(defaultBookSession, sfen);
    res.json(moves);
  } catch (e) {
    console.error("failed to search book moves:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to search book moves");
  }
});

app.post("/api/book/search/batch", express.json({ limit: "10mb" }), async (req, res) => {
  const sfens = req.body.sfens;
  if (!Array.isArray(sfens)) {
    res.status(400).send("sfens must be an array");
    return;
  }
  try {
    const results = await Promise.all(
      sfens.map(async (sfen) => {
        const moves = await searchBookMoves(defaultBookSession, sfen);
        return { sfen, moves };
      }),
    );
    res.json(results);
  } catch (e) {
    console.error("failed to batch search book moves:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to batch search book moves");
  }
});

app.post("/api/book/update", express.json(), async (req, res) => {
  const sfen = req.query.sfen;
  if (typeof sfen !== "string") {
    res.status(400).send("sfen is required");
    return;
  }
  try {
    await updateBookMove(defaultBookSession, sfen, req.body);
    res.send("ok");
  } catch (e) {
    console.error("failed to update book move:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to update book move");
  }
});

app.post("/api/book/remove", express.json(), async (req, res) => {
  const sfen = req.query.sfen;
  const usi = req.query.usi;
  if (typeof sfen !== "string" || typeof usi !== "string") {
    res.status(400).send("sfen and usi are required");
    return;
  }
  try {
    await removeBookMove(defaultBookSession, sfen, usi);
    res.send("ok");
  } catch (e) {
    console.error("failed to remove book move:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to remove book move");
  }
});

app.post("/api/book/order", express.json(), async (req, res) => {
  const sfen = req.query.sfen;
  const usi = req.query.usi;
  const order = parseInt(req.query.order as string, 10);
  if (typeof sfen !== "string" || typeof usi !== "string" || isNaN(order)) {
    res.status(400).send("sfen, usi and order are required");
    return;
  }
  try {
    await updateBookMoveOrder(defaultBookSession, sfen, usi, order);
    res.send("ok");
  } catch (e) {
    console.error("failed to update book move order:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to update book move order");
  }
});

app.post("/api/book/import", express.json(), async (req, res) => {
  if (!KIFU_DIR) {
    res.status(404).send("KIFU_DIR is not configured");
    return;
  }
  try {
    const settings = req.body;
    if (settings.sourceRecordFile && settings.sourceRecordFile.startsWith("server://")) {
      settings.sourceRecordFile = resolveKifuPath(KIFU_DIR, settings.sourceRecordFile.substring(9));
    }
    const summary = await importBookMoves(defaultBookSession, settings);
    res.json(summary);
  } catch (e) {
    console.error("failed to import book moves:", e);
    res.status(500).send(e instanceof Error ? e.message : "failed to import book moves");
  }
});

app.use(express.static(shogiHomePath));

app.get("/*", (req, res) => {
  res.sendFile(path.join(shogiHomePath, "index.html"));
});

enum EngineState {
  UNINITIALIZED,
  STARTING,
  WAITING_USIOK,
  WAITING_READYOK,
  READY,
  THINKING,
  STOPPING_SEARCH,
  TERMINATING,
  STOPPED,
}

type EngineHandle = {
  write: (command: string) => void;
  close: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off: (event: string, listener: (...args: unknown[]) => void) => void;
  removeAllListeners: (event?: string) => void;
};

// Custom type for WebSocket with isAlive property
interface ExtendedWebSocket extends WebSocket {
  isAlive?: boolean;
}

async function authenticateSocket(
  socket: net.Socket,
  accessToken: string,
): Promise<readline.Interface> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: socket });
    const onLine = (line: string) => {
      const msg = line.trim();
      if (msg.startsWith("auth_cram_sha256 ")) {
        const nonce = msg.substring("auth_cram_sha256 ".length).trim();
        const digest = crypto.createHmac("sha256", accessToken).update(nonce).digest("hex");
        socket.write(`auth ${digest}\n`);
      } else if (msg === "auth_ok") {
        rl.off("line", onLine);
        resolve(rl);
      } else if (msg.includes("WRAPPER_ERROR:")) {
        rl.close();
        reject(new Error(msg));
      } else if (msg !== "") {
        console.warn("Unexpected message during auth:", msg);
      }
    };
    rl.on("line", onLine);
    socket.once("error", (err) => {
      rl.close();
      reject(err);
    });
    socket.once("close", () => {
      rl.close();
      reject(new Error("Socket closed during authentication"));
    });
  });
}

class EngineSession {
  private currentEngineId: string | null = null;
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
      } catch (e) {
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
          if (["btime", "wtime", "byoyomi", "binc", "winc"].includes(t)) {
            if (i + 1 >= args.length || !/^-?\d+$/.test(args[i + 1])) return false;
            i++;
          } else if (t === "mate") {
            if (i + 1 >= args.length || !/^(\d+|infinite)$/.test(args[i + 1])) return false;
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
    this.engineState = EngineState.STOPPED;
    this.commandQueue.length = 0;
    this.postStopCommandQueue.length = 0;
    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }
    this.currentEngineSfen = null;
    this.pendingGoSfen = null;
    this.sendState();
    this.sendToClient({ info: "info: engine stopped" });
  }

  private setupEngineHandlers(stream: NodeJS.ReadableStream, rl?: readline.Interface) {
    const interface_ = rl || readline.createInterface({ input: stream });
    interface_.on("line", (line) => {
      if (!line.startsWith("info")) {
        console.log(`Engine output (${this.sessionId}): ${line}`);
      }

      if (line.trim().startsWith("WRAPPER_ERROR:")) {
        console.error(`Engine wrapper error: ${line}`);
        this.sendError(line);
        this.terminate();
        return;
      }

      this.sendToClient({ sfen: this.pendingGoSfen, info: line });

      if (line.startsWith("bestmove")) {
        if (this.engineState === EngineState.STOPPING_SEARCH) {
          if (this.stopTimeout) {
            clearTimeout(this.stopTimeout);
            this.stopTimeout = null;
          }

          // Filter and collect commands to replay.
          // We keep:
          // 1. All gameover and usinewgame commands.
          // 2. The latest MultiPV setoption.
          // 3. The latest position and go pair.
          let latestMultiPV: string | null = null;
          let latestGoIndex = -1;
          const importantCommands: { index: number; command: string }[] = [];

          for (let i = 0; i < this.postStopCommandQueue.length; i++) {
            const cmd = this.postStopCommandQueue[i];
            if (cmd.startsWith("setoption name MultiPV")) {
              latestMultiPV = cmd;
            } else if (cmd.startsWith("go")) {
              latestGoIndex = i;
            } else if (cmd === "usinewgame" || cmd.startsWith("gameover")) {
              importantCommands.push({ index: i, command: cmd });
            }
          }

          const commandsToRun: string[] = [];
          // 1. Replay MultiPV first if updated
          if (latestMultiPV) {
            commandsToRun.push(latestMultiPV);
          }

          // 2. Replay all other commands and the latest position/go in their relative order
          for (let i = 0; i < this.postStopCommandQueue.length; i++) {
            if (i === latestGoIndex) {
              // Find the corresponding position for this go
              let correspondingPosition: string | null = null;
              for (let j = i - 1; j >= 0; j--) {
                if (this.postStopCommandQueue[j].startsWith("position")) {
                  correspondingPosition = this.postStopCommandQueue[j];
                  break;
                }
              }
              if (correspondingPosition) {
                commandsToRun.push(correspondingPosition);
              }
              commandsToRun.push(this.postStopCommandQueue[i]);
            } else {
              const important = importantCommands.find((ic) => ic.index === i);
              if (important) {
                commandsToRun.push(important.command);
              }
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
      this.connectingSocket = null;
      console.log(`Connected to remote engine. Specifying engine ID: ${engineId}`);

      const accessToken = process.env.WRAPPER_ACCESS_TOKEN;

      const setup = (rl?: readline.Interface) => {
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
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Authentication failed: ${message}`);
          this.sendError(message);
          socket.destroy();
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
        this.stopTimeout = setTimeout(() => {
          if (this.engineState === EngineState.STOPPING_SEARCH) {
            console.warn("Engine did not respond to stop command. Resending.");
            this.sendToEngine("stop");
            this.stopTimeout = null;
          }
        }, 5000);
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

    if (this.engineState === EngineState.STOPPING_SEARCH) {
      if (command !== "stop") this.pushToQueue(this.postStopCommandQueue, command);
      return;
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
      if (
        this.engineHandle ||
        this.engineState === EngineState.STARTING ||
        (this.engineState as unknown) === EngineState.TERMINATING
      ) {
        this.sendError("engine already running, starting, or stopping");
        return;
      }
      this.startEngine(engineId);
      return;
    }

    if (command === "stop_engine") {
      this.isExplicitlyTerminated = true;
      if (this.engineHandle) {
        this.engineState = EngineState.TERMINATING;
        this.currentEngineId = null;
        this.commandQueue.length = 0;
        this.postStopCommandQueue.length = 0;
        if (this.stopTimeout) {
          clearTimeout(this.stopTimeout);
          this.stopTimeout = null;
        }
        this.currentEngineSfen = null;
        this.engineHandle.close();
      }
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

const getEngineList = (ws: WebSocket) => {
  console.log(`Fetching engine list from ${REMOTE_ENGINE_HOST}:${REMOTE_ENGINE_PORT}`);
  const socket = new net.Socket();
  let data = "";
  const accessToken = process.env.WRAPPER_ACCESS_TOKEN;
  const MAX_ENGINE_LIST_BYTES = 1 * 1024 * 1024; // 1 MB

  const connectionTimeout = setTimeout(() => {
    socket.destroy(new Error("Connection timed out"));
  }, 5000);

  socket.on("connect", async () => {
    clearTimeout(connectionTimeout);
    try {
      let rl: readline.Interface;
      if (accessToken) {
        rl = await authenticateSocket(socket, accessToken);
      } else {
        rl = readline.createInterface({ input: socket });
      }

      socket.write("list\n");

      rl.on("line", (line) => {
        const str = line.trim();
        if (str !== "") {
          data += str + "\n";
          if (data.length > MAX_ENGINE_LIST_BYTES) {
            console.error("Engine list response too large, aborting.");
            socket.destroy();
          }
        }
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to get engine list: ${message}`);
      socket.destroy();
    }
  });

  socket.on("end", () => {
    try {
      const engines = JSON.parse(data.trim());
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ engineList: engines }));
      }
    } catch (e) {
      console.error("Failed to parse engine list from wrapper:", e);
    }
  });

  socket.on("error", (err) => {
    clearTimeout(connectionTimeout);
    console.error("Failed to get engine list:", err);
  });

  socket.connect(REMOTE_ENGINE_PORT, REMOTE_ENGINE_HOST);
};

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

const BIND_ADDRESS = process.env.BIND_ADDRESS || "127.0.0.1";

server.listen(PORT, BIND_ADDRESS, () => {
  console.log(`Server is listening on ${BIND_ADDRESS}:${PORT}`);
  console.log(`Access ShogiHome at http://localhost:${PORT}`);
});
