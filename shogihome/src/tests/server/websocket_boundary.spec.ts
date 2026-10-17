// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { decodeServerRelayMessage } from "@/common/engine/relay_protocol";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "helpers/websocket_boundary_child.ts",
);
const headers = { Host: "localhost:8140", Origin: "http://localhost:8140" };
let child: ChildProcessWithoutNullStreams;
let port: number;
let stderr = "";
const browsers = new Set<WebSocket>();

beforeAll(async () => {
  child = spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "8140",
      DISABLE_AUTO_ALLOWED_ORIGINS: "true",
      ALLOWED_ORIGINS: headers.Origin,
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`WebSocket fixture startup timed out: ${stderr}`)),
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
      reject(new Error(`WebSocket fixture exited during startup: ${code}: ${stderr}`));
    });
    child.once("error", reject);
  });
}, 15000);

afterEach(() => {
  for (const ws of browsers) ws.terminate();
  browsers.clear();
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
});

async function connect(sessionId: string, suffix = ""): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?sessionId=${sessionId}${suffix}`, { headers });
  browsers.add(ws);
  const [data] = await once(ws, "message", { signal: AbortSignal.timeout(3000) });
  expect(decodeServerRelayMessage(data.toString())).toMatchObject({
    ok: true,
    value: { type: "state", state: "uninitialized" },
  });
  return ws;
}

async function expectPong(ws: WebSocket): Promise<void> {
  const pong = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", listener);
      reject(new Error(`WebSocket pong timed out: ${stderr}`));
    }, 3000);
    const listener = (data: WebSocket.RawData) => {
      const decoded = decodeServerRelayMessage(data.toString());
      if (decoded.ok && decoded.value.type === "notice" && decoded.value.notice === "pong") {
        clearTimeout(timer);
        ws.off("message", listener);
        resolve();
      }
    };
    ws.on("message", listener);
  });
  ws.send("ping");
  await pong;
}

async function status(): Promise<{ sessions: string[]; lateErrors: number }> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(3000),
  });
  expect(response.status).toBe(200);
  expect(child.exitCode, stderr).toBeNull();
  return response.json();
}

async function rawUpgrade(target: string, frame = Buffer.alloc(0)): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("Raw WebSocket timed out")));
    socket.on("connect", () => {
      socket.write(
        Buffer.concat([
          Buffer.from(
            `GET ${target} HTTP/1.1\r\n` +
              `Host: ${headers.Host}\r\n` +
              `Origin: ${headers.Origin}\r\n` +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              "Sec-WebSocket-Version: 13\r\n\r\n",
          ),
          frame,
        ]),
      );
    });
    socket.on("data", (data) => {
      response += data.toString();
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
    socket.on("close", () => resolve(response));
  });
}

it("keeps accepting WebSockets after an invalid upgrade URL", async () => {
  expect(await rawUpgrade("//[")).toContain("400 Bad Request");
  await expectPong(await connect("valid-upgrade-session"));
});

const oversized = Buffer.alloc(14);
oversized[0] = 0x82;
oversized[1] = 0xff;
oversized.writeBigUInt64BE(1048577n, 2);

it.each([
  { name: "unmasked frame", frame: Buffer.from([0x81, 0x00]) },
  { name: "oversized payload declaration", frame: oversized },
  { name: "invalid UTF-8", frame: Buffer.from([0x81, 0x81, 0, 0, 0, 0, 0xff]) },
])("isolates an $name without stopping HTTP or other WebSockets", async ({ frame }) => {
  const healthy = await connect("healthy-session");
  expect(await rawUpgrade("/?sessionId=malformed-session", frame)).toContain("101 Switching");
  await vi.waitFor(async () => {
    expect((await status()).sessions).not.toContain("malformed-session");
  });
  await expectPong(healthy);
  await expectPong(await connect("new-session"));
});

it.each(["/", "/?sessionId=rejected-session", "/ws/game-sessions/expired"])(
  "handles malformed frames while rejecting a connection at %s",
  async (target) => {
    expect(await rawUpgrade(target, Buffer.from([0x81, 0x00]))).toContain("101 Switching");
    await status();
    await expectPong(await connect("after-rejection-session"));
  },
);

it("ignores a replaced socket's late error without disconnecting its replacement", async () => {
  const previous = await connect("replacement-session", "&lateError=true");
  const closed = once(previous, "close", { signal: AbortSignal.timeout(3000) });
  const replacement = await connect("replacement-session");
  await closed;
  await vi.waitFor(async () => expect((await status()).lateErrors).toBeGreaterThan(0));
  expect((await status()).sessions).toContain("replacement-session");
  await expectPong(replacement);
});
