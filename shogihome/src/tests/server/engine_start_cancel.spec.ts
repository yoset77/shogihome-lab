import WebSocket from "ws";
import net from "net";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { killTree } from "./helpers/process";

const SERVER_PORT = 8200 + Math.floor(Math.random() * 1000);
const WRAPPER_PORT = 10900 + Math.floor(Math.random() * 1000);
const SERVER_URL = `ws://localhost:${SERVER_PORT}`;
const ACCESS_TOKEN = "test-access-token";

describe("Server engine startup cancellation", () => {
  let serverProcess: ChildProcess;
  let serverReady = false;
  let mockWrapperServer: net.Server;
  let ws: WebSocket | null = null;
  const activeSockets = new Set<net.Socket>();

  beforeAll(async () => {
    mockWrapperServer = net.createServer();
    mockWrapperServer.on("connection", (socket) => {
      activeSockets.add(socket);
      socket.on("close", () => activeSockets.delete(socket));
    });

    await new Promise<void>((resolve) => {
      mockWrapperServer.listen(WRAPPER_PORT, () => resolve());
    });

    const serverPath = path.resolve(__dirname, "../../../server.ts");
    serverProcess = spawn("npx", ["tsx", serverPath], {
      env: {
        ...process.env,
        PORT: SERVER_PORT.toString(),
        BIND_ADDRESS: "0.0.0.0",
        REMOTE_ENGINE_PORT: WRAPPER_PORT.toString(),
        ALLOWED_ORIGINS: `http://localhost:${SERVER_PORT}`,
        WRAPPER_ACCESS_TOKEN: ACCESS_TOKEN,
        ENGINE_STOP_TIMEOUT_MS: "2000",
      },
      stdio: "pipe",
      shell: true,
      detached: process.platform !== "win32",
    });

    await new Promise<void>((resolve, reject) => {
      serverProcess.stdout?.on("data", (data) => {
        const msg = data.toString();
        if (msg.includes(`Server is listening on 0.0.0.0:${SERVER_PORT}`)) {
          serverReady = true;
          resolve();
        }
      });
      serverProcess.stderr?.on("data", (data) => {
        process.stderr.write(`[SERVER STDERR] ${data.toString()}`);
      });
      setTimeout(() => {
        if (!serverReady) {
          reject(new Error("Server start timeout"));
        }
      }, 20000);
    });
  });

  afterEach(() => {
    if (ws) {
      ws.close();
      ws = null;
    }
  });

  afterAll(() => {
    if (serverProcess) {
      killTree(serverProcess);
    }
    if (mockWrapperServer) {
      mockWrapperServer.close();
    }
  });

  it("should not run the engine if stop_engine arrives during authentication", async () => {
    ws = new WebSocket(`${SERVER_URL}/?sessionId=test-start-cancel`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

    let runReceived = false;
    let authReceived = false;

    const wrapperConnected = new Promise<net.Socket>((resolve) => {
      mockWrapperServer.once("connection", (socket) => {
        socket.write("auth_cram_sha256 deadbeefdeadbeefdeadbeefdeadbeef\n");
        socket.on("data", (data) => {
          const commands = data.toString().split("\n");
          for (const raw of commands) {
            const command = raw.trim();
            if (!command) {
              continue;
            }
            if (command.startsWith("auth ")) {
              authReceived = true;
            }
            if (command === "run test-engine") {
              runReceived = true;
            }
          }
        });
        resolve(socket);
      });
    });

    ws.send("start_engine test-engine");
    const socket = await wrapperConnected;

    await vi.waitFor(() => {
      expect(authReceived).toBe(true);
    });

    ws.send("stop_engine");
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.write("auth_ok\n");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(runReceived).toBe(false);
  });
});
