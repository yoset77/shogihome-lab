// @vitest-environment node
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import net from "node:net";
import type * as EngineList from "@/server/engine/list";

let list: typeof EngineList;
let connections: net.Socket[];

function browser() {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn(),
    terminate: vi.fn(),
  });
}
const asWs = (ws: ReturnType<typeof browser>) => ws as unknown as WebSocket;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const payload = (budget = 4) => ({
  resources: { enabled: true, groups: [{ id: "g", name: "G", budget }] },
  engines: [{ id: "test", name: "Test", options: { Threads: 4 }, resource: { groupId: "g" } }],
});
function respond(socket: net.Socket, budget = 4) {
  socket.emit("data", Buffer.from(JSON.stringify(payload(budget)) + "\n"));
  socket.emit("end");
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  connections = [];
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket) {
    connections.push(this);
    vi.spyOn(this, "write").mockImplementation(() => true);
    void Promise.resolve().then(() => this.emit("connect"));
    return this;
  });
  list = await import("@/server/engine/list");
  vi.stubEnv("WRAPPER_ACCESS_TOKEN", "");
});

afterEach(() => {
  for (const socket of connections) socket.destroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("shares one fetch and one delivery per socket, removing disconnected waiters", async () => {
  const a = browser();
  const b = browser();
  for (let i = 0; i < 250; i++) list.getEngineList(asWs(a));
  list.getEngineList(asWs(b));
  await flush();
  expect(connections).toHaveLength(1);
  expect(a.listenerCount("close")).toBe(1);
  b.emit("close");
  respond(connections[0]);
  await flush();
  expect(a.send).toHaveBeenCalledOnce();
  expect(a.listenerCount("close")).toBe(0);
  expect(b.send).not.toHaveBeenCalled();
  list.getEngineList(asWs(a));
  expect(connections).toHaveLength(1);
  expect(a.send).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1000);
  list.getEngineList(asWs(a));
  expect(connections).toHaveLength(2);
  await flush();
  respond(connections[1]);
  await flush();
});

it("refreshes startup budgets independently of the display cache", async () => {
  const ws = browser();
  list.getEngineList(asWs(ws));
  await flush();
  respond(connections[0], 4);
  await flush();
  const first = list.fetchEngineConfigs();
  expect(list.fetchEngineConfigs()).toBe(first);
  await flush();
  expect(connections).toHaveLength(2);
  respond(connections[1], 2);
  await first;
  list.getEngineList(asWs(ws));
  const { resourceRegistry } = await import("@/server/engine/resources");
  expect(resourceRegistry.groupSnapshot()[0].budget).toBe(2);
  const next = list.fetchEngineConfigs();
  await flush();
  expect(connections).toHaveLength(3);
  respond(connections[2], 8);
  await next;
});

it("bounds unterminated wrapper responses and applies backpressure to list replies", async () => {
  const ws = browser();
  ws.bufferedAmount = 8 * 1024 * 1024;
  list.getEngineList(asWs(ws));
  await flush();
  respond(connections[0]);
  await flush();
  expect(ws.terminate).toHaveBeenCalledOnce();
  expect(ws.send).not.toHaveBeenCalled();
  const oversized = list.fetchEngineConfigs();
  const rejected = expect(oversized).rejects.toThrow("too large");
  await flush();
  connections[1].emit("data", Buffer.alloc(1024 * 1024 + 1, "x"));
  await rejected;
});

it.each(["error", "timeout"])(
  "recovers after %s with a bounded discovery retry cooldown",
  async (mode) => {
    const ws = browser();
    list.getEngineList(asWs(ws));
    await flush();
    if (mode === "error") connections[0].emit("error", new Error("unavailable"));
    else await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(ws.listenerCount("close")).toBe(0);
    list.getEngineList(asWs(ws));
    expect(connections).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    list.getEngineList(asWs(ws));
    await flush();
    expect(connections).toHaveLength(2);
    respond(connections[1]);
    await flush();
    expect(ws.send).toHaveBeenCalledOnce();
  },
);
