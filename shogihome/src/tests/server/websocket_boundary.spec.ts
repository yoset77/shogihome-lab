import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { expect, it } from "vitest";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "helpers/websocket_boundary_child.ts",
);

it("keeps accepting WebSockets after an invalid upgrade URL", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "8140", DISABLE_AUTO_ALLOWED_ORIGINS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("WebSocket fixture startup timed out")),
        10000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /READY:(\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket fixture exited during startup: ${code}`));
      });
      child.once("error", reject);
    });

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.setTimeout(3000, () => socket.destroy(new Error("Upgrade response timed out")));
      socket.on("connect", () => {
        socket.write(
          "GET //[ HTTP/1.1\r\n" +
            "Host: localhost:8140\r\n" +
            "Origin: http://localhost:8140\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      socket.once("data", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
      socket.once("close", () => resolve());
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?sessionId=valid-session`, {
      origin: "http://localhost:8140",
      headers: { Host: "localhost:8140" },
    });
    try {
      const message = await Promise.race([
        new Promise<string>((resolve, reject) => {
          ws.once("message", (data) => resolve(data.toString()));
          ws.once("error", reject);
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Valid connection timed out")), 3000),
        ),
      ]);
      expect(message).toBe("ready:1");
    } finally {
      ws.terminate();
    }
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
  }
}, 20000);
