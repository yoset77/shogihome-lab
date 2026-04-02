import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import WebSocket from "ws";
import net from "net";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { killTree } from "./helpers/process";

const SERVER_PORT = 8100 + Math.floor(Math.random() * 1000);
const WRAPPER_PORT = 9990 + Math.floor(Math.random() * 1000);
const SERVER_URL = `ws://localhost:${SERVER_PORT}`;

describe("Server USI Protocol & Implicit Stop", () => {
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
        ENGINE_STOP_TIMEOUT_MS: "2000",
      },
      stdio: "pipe",
      shell: true,
      detached: process.platform !== "win32",
    });

    await new Promise<void>((resolve, reject) => {
      serverProcess.stdout?.on("data", (data) => {
        const msg = data.toString();
        process.stdout.write(`[SERVER STDOUT] ${msg}`);
        if (msg.includes(`Server is listening on 0.0.0.0:${SERVER_PORT}`)) {
          serverReady = true;
          resolve();
        }
      });
      serverProcess.stderr?.on("data", (data) => {
        process.stderr.write(`[SERVER STDERR] ${data.toString()}`);
      });
      setTimeout(() => {
        if (!serverReady) reject(new Error("Server start timeout"));
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
      for (const socket of activeSockets) {
        socket.destroy();
      }
      mockWrapperServer.close();
    }
  });

  async function waitForEngineReady(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      const listener = (data: WebSocket.RawData) => {
        if (JSON.parse(data.toString()).info === "info: engine is ready") {
          ws!.off("message", listener);
          resolve();
        }
      };
      ws!.on("message", listener);
    });
  }

  it("should perform implicit stop when receiving 'position' while thinking", async () => {
    const sessionId = "test-implicit-stop";
    ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

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
  }, 30000);

  it("should queue commands while starting and flush them when ready", async () => {
    const sessionId = "test-queuing";
    ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

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
  });

  it("should handle normal go/bestmove flow correctly", async () => {
    const sessionId = "test-normal-flow";
    ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

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
          ws!.off("message", listener);
          resolve();
        }
      };
      ws!.on("message", listener);
    });

    await testFinished;
    ws.send("stop_engine");
  });

  it("should ignore late bestmove state transitions while terminating", async () => {
    const sessionId = "test-late-bestmove-terminating";
    ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

    const receivedStates: string[] = [];
    let stopRequested = false;
    const stoppedAfterTerminate = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws!.off("message", listener);
        reject(
          new Error(
            `Timed out waiting for stopped after stop_engine. States: ${receivedStates.join(", ")}`,
          ),
        );
      }, 2000);

      const listener = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (!stopRequested || !msg.state) {
          return;
        }
        receivedStates.push(msg.state);
        if (msg.state === "stopped") {
          clearTimeout(timeout);
          ws!.off("message", listener);
          resolve();
        }
      };

      ws!.on("message", listener);
    });

    const wrapperFinished = new Promise<void>((resolve) => {
      mockWrapperServer.once("connection", (socket) => {
        socket.on("data", (data) => {
          const cmds = data.toString().split("\n");
          for (const raw of cmds) {
            const cmd = raw.trim();
            if (!cmd) continue;
            if (cmd === "run test-engine") setTimeout(() => socket.write("usiok\n"), 10);
            if (cmd === "isready") setTimeout(() => socket.write("readyok\n"), 10);
            if (cmd.startsWith("go")) {
              setTimeout(() => {
                stopRequested = true;
                ws!.send("stop_engine");
              }, 10);
            }
          }
        });

        socket.on("end", () => {
          socket.write("bestmove 7g7f\n");
          setTimeout(() => {
            socket.end();
            resolve();
          }, 10);
        });
      });
    });

    ws.send("start_engine test-engine");
    await waitForEngineReady(ws);
    ws.send("position startpos");
    ws.send("go infinite");

    await wrapperFinished;
    await stoppedAfterTerminate;

    expect(receivedStates).not.toContain("ready");
    expect(receivedStates).toContain("stopped");
  });

  it("should replay multiple important commands correctly after bestmove", async () => {
    const sessionId = "test-replay-complex";
    ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

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
          ws!.off("message", listener);
          resolve();
        }
      };
      ws!.on("message", listener);
    });

    ws.send("position startpos moves 7g7f"); // Implicit stop
    ws.send("setoption name MultiPV value 3");
    ws.send("gameover win"); // Use gameover instead of usinewgame for sequence test
    ws.send("setoption name MultiPV value 5");
    ws.send("gameover draw");
    ws.send("position startpos moves 7g7f 3g3f");
    ws.send("go btime 1000 wtime 1000");

    await testFinished;
    // Expected order: MultiPV (latest) -> gameover (latest) -> position (latest) -> go (latest)
    expect(receivedAfterStop[0]).toBe("setoption name MultiPV value 5");
    expect(receivedAfterStop[1]).toBe("gameover draw");
    expect(receivedAfterStop[2]).toBe("position startpos moves 7g7f 3g3f");
    expect(receivedAfterStop[3]).toBe("go btime 1000 wtime 1000");
    ws.send("stop_engine");
  });

  it("should respect MAX_QUEUE_SIZE and drop old commands", async () => {
    const sessionId = "test-queue-limit";
    ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

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
  });

  it("should ignore commands after quit is received", async () => {
    const sessionId = "test-quit-idempotency";
    ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

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
              ws!.send("setoption name MultiPV value 10");
              ws!.send("position startpos");
              ws!.send("go infinite");
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
  });

  it("should force reset session on engine stop timeout", async () => {
    const sessionId = "test-stop-timeout";
    ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

    let stopReceived = false;
    mockWrapperServer.once("connection", (socket) => {
      socket.on("data", (data) => {
        const cmds = data.toString().split("\n");
        for (const cmd of cmds) {
          const c = cmd.trim();
          if (c === "run test-engine") setTimeout(() => socket.write("usiok\n"), 10);
          if (c === "isready") setTimeout(() => socket.write("readyok\n"), 10);
          if (c === "stop") {
            stopReceived = true;
            // Ignore stop command and don't send bestmove
          }
        }
      });
    });

    ws.send("start_engine test-engine");
    await waitForEngineReady(ws);
    ws.send("go infinite");

    // Wait for thinking state to ensure engine is busy.
    await new Promise<void>((resolve) => {
      const listener = (data: WebSocket.RawData) => {
        if (JSON.parse(data.toString()).state === "thinking") {
          ws!.off("message", listener);
          resolve();
        }
      };
      ws!.on("message", listener);
    });

    // Wait for both the error message and the stopped state transition.
    const resetPromise = new Promise<void>((resolve, reject) => {
      let errorReceived = false;
      let stateStoppedReceived = false;
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timeout waiting for reset messages. errorReceived=${errorReceived}, stateStoppedReceived=${stateStoppedReceived}`,
          ),
        );
      }, 10000);

      ws!.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.error === "error: Engine did not respond to stop command. Session reset.") {
          errorReceived = true;
        }
        if (msg.state === "stopped") {
          stateStoppedReceived = true;
        }
        if (errorReceived && stateStoppedReceived) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    ws.send("stop");

    await resetPromise;
    expect(stopReceived).toBe(true);

    ws.send("stop_engine");
  }, 20000);

  it("should sanitize engine list discovery payload", async () => {
    const sessionId = "discovery-test";
    ws = new WebSocket(`${SERVER_URL}/?sessionId=${sessionId}`, {
      origin: `http://localhost:${SERVER_PORT}`,
    });
    await new Promise<void>((resolve) => ws!.on("open", resolve));

    const testFinished = new Promise<void>((resolve) => {
      mockWrapperServer.once("connection", (socket) => {
        socket.on("data", (data) => {
          const cmd = data.toString().trim();
          if (cmd === "list") {
            socket.write(
              JSON.stringify([
                { id: "engine1", name: "Engine 1", type: "game", path: "/secret/path/1" },
                { id: "engine2", name: "Engine 2", type: "research", path: "/secret/path/2" },
              ]) + "\n",
            );
            setTimeout(() => socket.end(), 10);
            resolve();
          }
        });
      });
    });

    ws.send("get_engine_list");

    const engineListPromise = new Promise<
      { id: string; name: string; type?: string; path?: string }[]
    >((resolve) => {
      ws!.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.engineList) {
          resolve(msg.engineList);
        }
      });
    });

    const list = await engineListPromise;
    await testFinished;

    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("engine1");
    expect(list[0].path).toBeUndefined(); // Path should be removed
    expect(list[1].id).toBe("engine2");
    expect(list[1].path).toBeUndefined(); // Path should be removed
  });
});
