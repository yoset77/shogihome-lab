import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import readline from "readline";
import { killTree } from "./helpers/process";

const SERVER_PORT = 8090 + Math.floor(Math.random() * 1000); // Avoid conflict
const SERVER_URL = `ws://localhost:${SERVER_PORT}`;

describe("Server Session Reconnection", () => {
  let serverProcess: ChildProcess;
  let serverReady = false;

  beforeAll(async () => {
    // Start server.ts in a child process
    const serverPath = path.resolve(__dirname, "../../../server.ts");
    serverProcess = spawn("npx", ["tsx", serverPath], {
      env: {
        ...process.env,
        PORT: SERVER_PORT.toString(),
        BIND_ADDRESS: "0.0.0.0",
        REMOTE_ENGINE_PORT: "9999",
        ALLOWED_ORIGINS: `http://localhost:${SERVER_PORT}`,
        WRAPPER_ACCESS_TOKEN: "", // Disable auth for tests
      }, // Dummy engine port
      stdio: "pipe",
      shell: true,
      detached: process.platform !== "win32",
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const rl = readline.createInterface({ input: serverProcess.stdout! });
      rl.on("line", (line) => {
        // console.log("[Server]:", line); // Uncomment for debugging
        if (line.includes(`Server is listening on 0.0.0.0:${SERVER_PORT}`)) {
          serverReady = true;
          resolve();
        }
      });

      serverProcess.on("error", (err) => {
        reject(err);
      });

      serverProcess.stderr?.on("data", (data) => {
        console.error("[Server Error]:", data.toString());
      });

      setTimeout(() => {
        if (!serverReady) reject(new Error("Server start timeout"));
      }, 60000);
    });
  }, 60000);

  afterAll(() => {
    if (serverProcess) {
      killTree(serverProcess);
    }
  });

  it("should accept connection with sessionId", async () => {
    const sessionId = "test-session-1";
    const ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.close();
        resolve();
      });
      ws.on("error", reject);
    });
  });

  it("should allow reconnection with the same sessionId", async () => {
    const sessionId = "test-session-reconnect";

    // 1. Initial Connection
    const ws1 = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws1.on("open", resolve));

    // 2. Disconnect
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 500)); // Wait for server to handle disconnect

    // 3. Reconnect
    const ws2 = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });

    const connected = await new Promise<boolean>((resolve) => {
      ws2.on("open", () => resolve(true));
      ws2.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 2000);
    });

    expect(connected).toBe(true);
    ws2.close();
  }, 30000);

  it("should handle rapid reconnection (socket replacement) correctly", async () => {
    const sessionId = "test-session-replacement";

    // 1. Initial Connection
    const ws1 = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws1.on("open", resolve));

    // 2. Connect second socket IMMEDIATELY (simulating tab reload or takeover)
    const ws2 = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });

    await new Promise<void>((resolve) => ws2.on("open", resolve));

    // 3. Close the first socket (which might happen after the second connects)
    // In the buggy implementation, this would trigger handleDisconnect and kill the session's ref to ws2
    ws1.close();

    // 4. Send ping from ws2 and expect pong
    // If session is detached, this might fail or not get response
    const pongReceived = await new Promise<boolean>((resolve) => {
      ws2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.info === "pong") resolve(true);
      });
      ws2.send("ping");
      setTimeout(() => resolve(false), 2000);
    });

    expect(pongReceived).toBe(true);
    ws2.close();
  }, 30000);

  it("should reject connection without sessionId", async () => {
    const ws = new WebSocket(`${SERVER_URL}/`, {
      origin: `http://localhost:${SERVER_PORT}`,
    }); // No sessionId

    const closedCorrectly = await new Promise<boolean>((resolve) => {
      ws.on("open", () => {
        // Should not open, but if it does, it's a fail (unless server closes immediately)
      });
      ws.on("close", (code, reason) => {
        if (code === 1008 && reason.toString() === "sessionId required") {
          resolve(true);
        } else {
          resolve(false);
        }
      });
      ws.on("error", () => {
        // Some clients might throw error on immediate close
        resolve(true);
      });
    });

    expect(closedCorrectly).toBe(true);
  });
});
