import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import net from "net";
import { spawn, ChildProcess } from "child_process";
import path from "path";

const SERVER_PORT = 8100 + Math.floor(Math.random() * 1000);
const WRAPPER_PORT = 9990 + Math.floor(Math.random() * 1000);
const SERVER_URL = `ws://localhost:${SERVER_PORT}`;

describe("Server USI Protocol & Implicit Stop", () => {
  let serverProcess: ChildProcess;
  let serverReady = false;
  let mockWrapperServer: net.Server;

  beforeAll(async () => {
    mockWrapperServer = net.createServer();
    await new Promise<void>((resolve) => {
      mockWrapperServer.listen(WRAPPER_PORT, () => {
        console.log(`Mock Wrapper listening on ${WRAPPER_PORT}`);
        resolve();
      });
    });

    const serverPath = path.resolve(__dirname, "../../../server.ts");
    serverProcess = spawn("npx", ["tsx", serverPath], {
      env: {
        ...process.env,
        PORT: SERVER_PORT.toString(),
        BIND_ADDRESS: "0.0.0.0",
        REMOTE_ENGINE_PORT: WRAPPER_PORT.toString(),
        ALLOWED_ORIGINS: `http://localhost:${SERVER_PORT}`,
        WRAPPER_ACCESS_TOKEN: "",
      },
      stdio: "pipe",
      shell: true,
    });

    await new Promise<void>((resolve, reject) => {
      serverProcess.stdout?.on("data", (data) => {
        const msg = data.toString();
        if (msg.includes(`Server is listening on 0.0.0.0:${SERVER_PORT}`)) {
          serverReady = true;
          resolve();
        }
      });
      setTimeout(() => {
        if (!serverReady) reject(new Error("Server start timeout"));
      }, 20000);
    });
  });

  afterAll(() => {
    if (serverProcess) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", serverProcess.pid!.toString(), "/f", "/t"]);
      } else {
        serverProcess.kill();
      }
    }
    if (mockWrapperServer) {
      mockWrapperServer.close();
    }
  });

  async function waitForEngineReady(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      const listener = (data: WebSocket.RawData) => {
        if (JSON.parse(data.toString()).info === "info: engine is ready") {
          ws.off("message", listener);
          resolve();
        }
      };
      ws.on("message", listener);
    });
  }

  it("should perform implicit stop when receiving 'position' while thinking", async () => {
    const sessionId = "test-implicit-stop";
    const ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws.on("open", resolve));

    let stopReceived = false;
    const testFinished = new Promise<void>((resolve) => {
      mockWrapperServer.once("connection", (socket) => {
        socket.on("data", (data) => {
          const cmds = data.toString().split("\n");
          for (const cmd of cmds) {
            const c = cmd.trim();
            if (c === "run test-engine") setTimeout(() => socket.write("usiok\n"), 10);
            if (c === "isready") setTimeout(() => socket.write("readyok\n"), 10);
            if (c === "stop") {
              stopReceived = true;
              setTimeout(() => {
                socket.write("bestmove 7g7f\n");
                resolve();
              }, 10);
            }
          }
        });
      });
    });

    ws.send("start_engine test-engine");
    await waitForEngineReady(ws);
    ws.send("position startpos");
    ws.send("go infinite");
    ws.send("position startpos moves 7g7f");
    await testFinished;
    expect(stopReceived).toBe(true);
    ws.send("stop_engine");
    ws.close();
  });

  it("should queue commands while starting and flush them when ready", async () => {
    const sessionId = "test-queuing";
    const ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const receivedCommands: string[] = [];
    const testFinished = new Promise<void>((resolve) => {
      mockWrapperServer.once("connection", (socket) => {
        socket.on("data", (data) => {
          const cmds = data.toString().split("\n");
          for (const c of cmds) {
            const cmd = c.trim();
            if (!cmd) continue;
            if (cmd === "run test-engine") setTimeout(() => socket.write("usiok\n"), 10);
            if (cmd === "isready") setTimeout(() => socket.write("readyok\n"), 10);
            if (!cmd.startsWith("run ") && cmd !== "usi" && cmd !== "isready") {
              receivedCommands.push(cmd);
              if (cmd === "setoption name MultiPV value 5") resolve();
            }
          }
        });
      });
    });

    ws.send("start_engine test-engine");
    ws.send("setoption name MultiPV value 5");
    await testFinished;
    expect(receivedCommands).toContain("setoption name MultiPV value 5");
    ws.send("stop_engine");
    ws.close();
  });

  it("should handle normal go/bestmove flow correctly", async () => {
    const sessionId = "test-normal-flow";
    const ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const testFinished = new Promise<void>((resolve) => {
      mockWrapperServer.once("connection", (socket) => {
        socket.on("data", (data) => {
          const cmds = data.toString().split("\n");
          for (const cmd of cmds) {
            const c = cmd.trim();
            if (c === "run test-engine") setTimeout(() => socket.write("usiok\n"), 10);
            if (c === "isready") setTimeout(() => socket.write("readyok\n"), 10);
            if (c.startsWith("go")) {
              setTimeout(() => {
                socket.write("bestmove 7g7f\n");
                resolve();
              }, 50);
            }
          }
        });
      });
    });

    ws.send("start_engine test-engine");
    await waitForEngineReady(ws);
    ws.send("position startpos");
    ws.send("go btime 1000");

    await new Promise<void>((resolve) => {
      const listener = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (msg.info && msg.info.startsWith("bestmove")) {
          ws.off("message", listener);
          resolve();
        }
      };
      ws.on("message", listener);
    });

    await testFinished;
    ws.send("stop_engine");
    ws.close();
  });

  it("should replay multiple important commands correctly after bestmove", async () => {
    const sessionId = "test-replay-complex";
    const ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const receivedAfterStop: string[] = [];
    let bestmoveSent = false;
    const testFinished = new Promise<void>((resolve) => {
      mockWrapperServer.once("connection", (socket) => {
        socket.on("data", (data) => {
          const cmds = data.toString().split("\n");
          for (const c of cmds) {
            const cmd = c.trim();
            if (!cmd) continue;
            if (cmd === "run test-engine") setTimeout(() => socket.write("usiok\n"), 10);
            if (cmd === "isready") setTimeout(() => socket.write("readyok\n"), 10);
            if (cmd === "stop" && !bestmoveSent) {
              setTimeout(() => {
                bestmoveSent = true;
                socket.write("bestmove 7g7f\n");
              }, 500);
            } else if (bestmoveSent) {
              receivedAfterStop.push(cmd);
              if (cmd.startsWith("go")) resolve();
            }
          }
        });
      });
    });

    ws.send("start_engine test-engine");
    await waitForEngineReady(ws);
    ws.send("position startpos");
    ws.send("go infinite");
    await new Promise<void>((resolve) => {
      const listener = (data: WebSocket.RawData) => {
        if (JSON.parse(data.toString()).state === "thinking") {
          ws.off("message", listener);
          resolve();
        }
      };
      ws.on("message", listener);
    });

    ws.send("position startpos moves 7g7f"); // Implicit stop
    ws.send("setoption name MultiPV value 3");
    ws.send("gameover win"); // Use gameover instead of usinewgame for sequence test
    ws.send("setoption name MultiPV value 5");
    ws.send("gameover draw");
    ws.send("position startpos moves 7g7f 3g3f");
    ws.send("go btime 1000 wtime 1000");

    await testFinished;
    // Expected order: MultiPV (latest) -> gameover win -> gameover draw -> position (latest) -> go (latest)
    expect(receivedAfterStop[0]).toBe("setoption name MultiPV value 5");
    expect(receivedAfterStop[1]).toBe("gameover win");
    expect(receivedAfterStop[2]).toBe("gameover draw");
    expect(receivedAfterStop[3]).toBe("position startpos moves 7g7f 3g3f");
    expect(receivedAfterStop[4]).toBe("go btime 1000 wtime 1000");
    ws.send("stop_engine");
    ws.close();
  });

  it("should respect MAX_QUEUE_SIZE and drop old commands", async () => {
    const sessionId = "test-queue-limit";
    const ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws.on("open", resolve));

    for (let i = 0; i < 150; i++) {
      ws.send(`gameover win`); // Use gameover as it's not filtered
    }

    const receivedCommands: string[] = [];
    const testFinished = new Promise<void>((resolve) => {
      mockWrapperServer.once("connection", (socket) => {
        socket.on("data", (data) => {
          const cmds = data.toString().split("\n");
          for (const c of cmds) {
            const cmd = c.trim();
            if (cmd === "run test-engine") setTimeout(() => socket.write("usiok\n"), 10);
            if (cmd === "isready") setTimeout(() => socket.write("readyok\n"), 10);
            if (
              cmd &&
              !cmd.startsWith("run ") &&
              cmd !== "usi" &&
              cmd !== "isready" &&
              cmd !== "usinewgame"
            ) {
              receivedCommands.push(cmd);
              if (receivedCommands.length >= 100) resolve();
            }
          }
        });
      });
    });

    ws.send("start_engine test-engine");
    await testFinished;
    expect(receivedCommands.length).toBe(100);
    expect(receivedCommands.every((c) => c === "gameover win")).toBe(true);
    ws.send("stop_engine");
    ws.close();
  });

  it("should ignore commands after quit is received", async () => {
    const sessionId = "test-quit-idempotency";
    const ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const receivedAfterQuit: string[] = [];
    let quitProcessed = false;
    const testFinished = new Promise<void>((resolve) => {
      mockWrapperServer.once("connection", (socket) => {
        socket.on("data", (data) => {
          const cmds = data.toString().split("\n");
          for (const c of cmds) {
            const cmd = c.trim();
            if (cmd === "run test-engine") setTimeout(() => socket.write("usiok\n"), 10);
            if (cmd === "isready") setTimeout(() => socket.write("readyok\n"), 10);
            if (cmd === "quit") {
              quitProcessed = true;
              ws.send("setoption name MultiPV value 10");
              ws.send("position startpos");
              ws.send("go infinite");
              setTimeout(resolve, 200);
            } else if (
              quitProcessed &&
              cmd &&
              !cmd.startsWith("run ") &&
              cmd !== "usi" &&
              cmd !== "isready" &&
              cmd !== "usinewgame"
            ) {
              receivedAfterQuit.push(cmd);
            }
          }
        });
      });
    });

    ws.send("start_engine test-engine");
    await waitForEngineReady(ws);
    ws.send("quit");
    await testFinished;
    expect(receivedAfterQuit).toHaveLength(0);
    ws.send("stop_engine");
    ws.close();
  });
});
