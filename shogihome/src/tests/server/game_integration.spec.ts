// @vitest-environment node
import net from "node:net";
import http from "node:http";
import readline from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import WebSocket from "ws";
import { GameSessionManager, acquireGameResourceLease } from "@/server/game/manager";
import { resourceRegistry } from "@/server/engine/resources";
import { createGameSessionRoutes } from "@/server/routes/game_sessions";
import { createEngineWebSocketServer } from "@/server/websocket";
import { handleError } from "@/server/errors";
import { ALLOWED_ORIGINS, ALLOWED_HOSTS } from "@/server/config";
import { decodeGameFrame, type GameSnapshot } from "@/common/game/protocol";
import { restoreRecord } from "@/common/record/snapshot";
import { gameRequest, gameCommand } from "./helpers/game";
import type { AppEnv } from "@/server/hono";
import { getHistory } from "@/server/file/history";
import { HistoryClass } from "@/common/file/history";
import { importKIF, Record } from "tsshogi";

const wrapperConfig = vi.hoisted(() => ({ port: 0, directory: "" }));
vi.mock("@/node/proc/path", () => ({ getUserDataPath: () => wrapperConfig.directory }));
vi.mock("@/server/config", async (original) => ({
  ...(await original<typeof import("@/server/config")>()),
  REMOTE_ENGINE_HOST: "127.0.0.1",
  get REMOTE_ENGINE_PORT() {
    return wrapperConfig.port;
  },
}));
vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));

const modes = process.env.SHOGIHOME_WRAPPER_EXE ? ["tcp", "rust"] : ["tcp"];
describe.each(modes)("game HTTP/WebSocket/USI integration (%s)", (mode) => {
  let manager: GameSessionManager;
  let middle: http.Server;
  let tcp: net.Server | undefined;
  let child: ChildProcess | undefined;
  let directory: string | undefined;
  let url: string;
  const connections = new Set<net.Socket>();
  const browsers = new Set<WebSocket>();
  let commands: string[];
  const saveRecord = vi.fn(async () => "saved.kifu");
  const token = process.env.WRAPPER_ACCESS_TOKEN;
  const config = { id: "test-game", name: "Game Fixture", type: ["game"], skipAnalysisDB: true };
  const headers = {
    "Content-Type": "application/json",
    Origin: ALLOWED_ORIGINS[0],
    Host: [...ALLOWED_HOSTS][0],
  };

  beforeEach(async () => {
    delete process.env.WRAPPER_ACCESS_TOKEN;
    commands = [];
    saveRecord.mockReset().mockResolvedValue("saved.kifu");
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "game-wrapper-"));
    wrapperConfig.directory = path.join(directory, "data");
    if (mode === "rust") {
      const script = path.join(directory, "engine.mjs");
      await fs.writeFile(
        script,
        `#!${process.execPath}\n` +
          (await fs.readFile(new URL("./helpers/game_engine.mjs", import.meta.url), "utf8")),
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(directory, "engines.json"),
        JSON.stringify([{ ...config, path: script }]),
      );
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      wrapperConfig.port = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        BIND_ADDRESS: "127.0.0.1",
        LISTEN_PORT: String(wrapperConfig.port),
        GAME_TEST_LOG: path.join(directory, "engine.log"),
      };
      delete env.WRAPPER_ACCESS_TOKEN;
      child = spawn(process.env.SHOGIHOME_WRAPPER_EXE!, ["--config-dir", directory], {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let childLog = "";
      child.stdout?.on("data", (data) => {
        childLog += data.toString();
      });
      child.stderr?.on("data", (data) => {
        childLog += data.toString();
      });
      await vi.waitFor(
        () => {
          expect(childLog).toContain(`listening on 127.0.0.1:${wrapperConfig.port}`);
        },
        { timeout: 10_000, interval: 50 },
      );
      child.on("exit", (code) => {
        if (code !== 0 && childLog) console.error(childLog);
      });
    } else {
      tcp = net.createServer((socket) => {
        connections.add(socket);
        let position = "position startpos";
        let timer: ReturnType<typeof setTimeout> | undefined;
        socket.on("close", () => {
          clearTimeout(timer);
          connections.delete(socket);
        });
        readline.createInterface({ input: socket }).on("line", (line) => {
          commands.push(line);
          if (line === "list") socket.end(JSON.stringify([config]) + "\n");
          else if (line === "usi") socket.write("id name Game Fixture\nusiok\n");
          else if (line === "isready") socket.write("readyok\n");
          else if (line.startsWith("position ")) position = line;
          else if (line.startsWith("go ")) {
            const ply = position.includes(" moves ")
              ? position.split(" moves ")[1].split(" ").length
              : 0;
            const move = ["7g7f", "3c3d", "2g2f", "8c8d"][ply] ?? "resign";
            socket.write(
              `info depth 8 score cp 20 nodes 100 pv ${move === "resign" ? "7g7f" : move}\n`,
            );
            timer = setTimeout(() => socket.write(`bestmove ${move}\n`), 200);
          } else if (line === "stop") {
            clearTimeout(timer);
            socket.write("info depth 99 score cp 999 pv 3c3d\nbestmove resign\n");
          }
        });
      });
      await new Promise<void>((resolve) => tcp!.listen(0, "127.0.0.1", resolve));
      wrapperConfig.port = (tcp.address() as net.AddressInfo).port;
    }
    manager = new GameSessionManager({
      resolveEngine: async () => config,
      saveRecord,
    });
    const app = new Hono<AppEnv>().route("/api/game-sessions", createGameSessionRoutes(manager));
    app.onError(handleError);
    middle = http.createServer(getRequestListener(app.fetch));
    createEngineWebSocketServer(middle, { getOrCreateSession: () => null }, manager);
    await new Promise<void>((resolve) => middle.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(middle.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const browser of browsers) browser.terminate();
    browsers.clear();
    await manager?.close();
    resourceRegistry.resetForTest();
    if (middle) await new Promise<void>((resolve) => middle.close(() => resolve()));
    for (const socket of connections) socket.destroy();
    connections.clear();
    if (tcp) await new Promise<void>((resolve) => tcp!.close(() => resolve()));
    tcp = undefined;
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    child = undefined;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    directory = undefined;
    if (token === undefined) delete process.env.WRAPPER_ACCESS_TOKEN;
    else process.env.WRAPPER_ACCESS_TOKEN = token;
  });
  const call = async (pathname: string, body?: unknown) => {
    const response = await fetch(url + "/api/game-sessions" + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBeLessThan(300);
    return response.json();
  };
  const browserURL = (snapshot: GameSnapshot, connectionId: string) =>
    url.replace("http:", "ws:") +
    `/ws/game-sessions/${snapshot.sessionId}?controllerId=controller&serverInstanceId=${snapshot.serverInstanceId}&connectionId=${connectionId}&controllerEpoch=${snapshot.controllerEpoch}&screenId=screen&recoveryId=${snapshot.controllerRecoveryId}`;
  let nextConnection = 0;
  async function browser(snapshot: GameSnapshot, connectionId = `browser-${++nextConnection}`) {
    const ws = new WebSocket(browserURL(snapshot, connectionId), { headers });
    browsers.add(ws);
    const frames: GameSnapshot[] = [];
    ws.on("message", (data) => {
      const decoded = decodeGameFrame(JSON.parse(data.toString()));
      expect(decoded.ok).toBe(true);
      if (decoded.ok && decoded.value.type === "snapshot") frames.push(decoded.value.value);
    });
    await once(ws, "open");
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    return { ws, frames, latest: () => frames.at(-1)! };
  }

  it("disconnects a malformed WebSocket through close and accepts a replacement", async () => {
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    const created = (await call("", request)) as GameSnapshot;
    const first = await browser(created);
    const session = manager.get(created.sessionId);
    expect(session.attachment().attached).toBe(true);
    const closed = once(first.ws, "close");
    first.ws.send(Buffer.from([0xff]), { binary: false });
    await closed;
    await vi.waitFor(() => expect(session.attachment().attached).toBe(false));
    const replacement = await browser(session.snapshot());
    expect(replacement.ws.readyState).toBe(WebSocket.OPEN);
    expect(session.attachment().attached).toBe(true);
  });

  it("rejects a stale reconnect over WebSocket without replacing the active browser", async () => {
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    const created = (await call("", request)) as GameSnapshot;
    const first = await browser(created, "first");
    const stale = first.latest();
    first.ws.terminate();
    await vi.waitFor(() => expect(manager.get(created.sessionId).snapshot().state).toBe("paused"));
    const replacement = await browser(stale, "replacement");
    await call(`/${created.sessionId}/commands`, gameCommand(replacement.latest(), "resume"));
    await vi.waitFor(() => expect(replacement.latest().canMove).toBe(true));
    const epoch = replacement.latest().controllerEpoch;
    const retry = new WebSocket(browserURL(stale, "first"), { headers });
    browsers.add(retry);
    const [code] = await once(retry, "close");
    expect(code).toBe(4001);
    expect(replacement.ws.readyState).toBe(WebSocket.OPEN);
    expect(manager.get(created.sessionId).snapshot().controllerEpoch).toBe(epoch);
    expect(manager.get(created.sessionId).snapshot().state).toBe("running");
  });

  it.each([
    { connectionId: "", controllerEpoch: "0" },
    { connectionId: "browser", controllerEpoch: "NaN" },
    { connectionId: "browser", controllerEpoch: "9007199254740992" },
  ])("rejects malformed reconnect identifiers: %j", async (binding) => {
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    const created = (await call("", request)) as GameSnapshot;
    const target = new URL(browserURL(created, "browser"));
    target.searchParams.set("connectionId", binding.connectionId);
    target.searchParams.set("controllerEpoch", binding.controllerEpoch);
    const ws = new WebSocket(target, { headers });
    browsers.add(ws);
    const [code] = await once(ws, "close");
    expect(code).toBe(1008);
    expect(manager.get(created.sessionId).snapshot().controllerEpoch).toBe(0);
  });

  it("pauses after a disconnected AI reply and recovers before accepting another human move", async () => {
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    request.settings.white = { uri: "lan-engine:test-game", name: "AI" };
    const created = (await call("", request)) as GameSnapshot;
    await vi.waitFor(() => expect(manager.get(created.sessionId).snapshot().state).toBe("paused"));
    const first = await browser(created);
    await call(`/${created.sessionId}/commands`, gameCommand(first.latest(), "resume"));
    await vi.waitFor(() => expect(first.latest().canMove).toBe(true));
    await call(
      `/${created.sessionId}/commands`,
      gameCommand(first.latest(), "move", { move: "7g7f" }),
    );
    first.ws.terminate();
    await vi.waitFor(() => expect(manager.get(created.sessionId).snapshot().state).toBe("paused"));
    const recovered = (await call(`/by-request/${request.requestId}`)) as GameSnapshot;
    expect(restoreRecord(recovered.record).record.current.ply).toBe(2);
    expect(recovered.controllerRecoveryId).toBeUndefined();
    const owned = (await call(`/${created.sessionId}/attached-snapshot`, {
      ownerId: "controller",
      epoch: first.latest().controllerEpoch,
      recoveryId: first.latest().controllerRecoveryId,
      screenId: "screen",
      takeover: false,
    })) as GameSnapshot;
    const second = await browser(owned);
    expect(second.latest().canMove).toBe(false);
    await call(`/${created.sessionId}/commands`, gameCommand(second.latest(), "resume"));
    await vi.waitFor(() => expect(second.latest().canMove).toBe(true));
    await call(`/${created.sessionId}/commands`, gameCommand(second.latest(), "interrupt"));
    await manager.get(created.sessionId).completion;
    expect(manager.get(created.sessionId).snapshot().state).toBe("completed");
  });

  it("settles USI cancellation before rollback and rejects cancelled bestmove", async () => {
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    request.settings.white = { uri: "lan-engine:test-game", name: "AI" };
    const created = (await call("", request)) as GameSnapshot;
    await vi.waitFor(() => expect(manager.get(created.sessionId).snapshot().state).toBe("paused"));
    const client = await browser(created);
    await call(`/${created.sessionId}/commands`, gameCommand(client.latest(), "resume"));
    await vi.waitFor(() => expect(client.latest().canMove).toBe(true));
    await call(
      `/${created.sessionId}/commands`,
      gameCommand(client.latest(), "move", { move: "7g7f" }),
    );
    await vi.waitFor(() =>
      expect(manager.get(created.sessionId).snapshot().clocks.white.running).toBe(true),
    );
    const rolledBack = (await call(
      `/${created.sessionId}/commands`,
      gameCommand(manager.get(created.sessionId).snapshot(), "takeback"),
    )) as GameSnapshot;
    expect(restoreRecord(rolledBack.record).record.current.ply).toBe(0);
    expect(rolledBack.state).toBe("running");
    if (mode === "rust" && directory)
      commands = (await fs.readFile(path.join(directory, "engine.log"), "utf8")).trim().split("\n");
    expect(commands).toContain("stop");
    expect(
      rolledBack.record.nodes.some((node) => node.customData?.opponentSearchInfo?.depth === 99),
    ).toBe(false);
  });

  it("finishes repeated AI games with no browser and releases both TCP engines", async () => {
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    request.settings.black = request.settings.white = { uri: "lan-engine:test-game", name: "AI" };
    request.settings.repeat = 2;
    request.settings.swapPlayers = true;
    request.settings.enableAutoSave = true;
    const created = (await call("", request)) as GameSnapshot;
    await manager.get(created.sessionId).completion;
    const result = (await call(`/${created.sessionId}`)) as GameSnapshot;
    expect(result).toMatchObject({ state: "completed", results: { total: 2 } });
    expect(result.records.map((record) => record.state)).toEqual(["saved", "saved"]);
    expect((await getHistory()).entries).toMatchObject([
      { class: HistoryClass.USER, userFilePath: "server://saved.kifu" },
    ]);
    if (mode === "rust" && directory)
      commands = (await fs.readFile(path.join(directory, "engine.log"), "utf8")).trim().split("\n");
    expect(commands.filter((line) => line === "usinewgame")).toHaveLength(4);
    expect(commands.some((line) => line.startsWith("go btime "))).toBe(true);
    expect(commands.some((line) => line.startsWith("go ponder"))).toBe(false);
    await vi.waitFor(() => expect(connections.size).toBe(0));
  });
  it("runs parallel games without a browser, reuses four TCP engines, and holds aggregate resources", async () => {
    resourceRegistry.resetForTest(true, [{ id: "g", name: "G", budget: 8 }]);
    manager = new GameSessionManager({
      resolveEngine: async () => ({ ...config, threads: 4, resource: { groupId: "g" } }),
      acquireResourceLease: acquireGameResourceLease,
      saveRecord,
    });
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    request.settings.black = request.settings.white = { uri: "lan-engine:test-game", name: "Same" };
    Object.assign(request.settings, {
      repeat: 4,
      parallelism: 2,
      swapPlayers: true,
      enableAutoSave: true,
    });
    // This manager uses the same actual TCP/USI bridge as the HTTP fixture.
    const session = await manager.create(request);
    await vi.waitFor(() => expect(resourceRegistry.groupSnapshot()[0].used).toBe(8));
    if (mode === "tcp") await vi.waitFor(() => expect(connections.size).toBe(4));
    await session.completion;
    expect(session.summary()).toMatchObject({
      state: "completed",
      completed: 4,
      parallelGame: {
        activeGames: 0,
        results: { player1: { win: 2, winWhite: 2 }, player2: { win: 2, winWhite: 2 }, total: 4 },
      },
    });
    expect(saveRecord).toHaveBeenCalledTimes(4);
    expect(new Set(saveRecord.mock.calls.map((call) => (call as unknown[])[2])).size).toBe(4);
    if (mode === "rust" && directory)
      commands = (await fs.readFile(path.join(directory, "engine.log"), "utf8")).trim().split("\n");
    expect(commands.filter((line) => line === "usi")).toHaveLength(4);
    expect(commands.filter((line) => line === "usinewgame")).toHaveLength(8);
    expect(commands.filter((line) => line.startsWith("go btime "))).toHaveLength(20);
    expect(resourceRegistry.groupSnapshot()[0].used).toBe(0);
    await vi.waitFor(() => expect(connections.size).toBe(0));
  });

  it.each([false, true])(
    "backs up detached repeated games in history when auto-saving fails or is disabled (%s)",
    async (autoSave) => {
      saveRecord.mockRejectedValue(new Error("Save unavailable"));
      const request = gameRequest();
      request.serverInstanceId = manager.serverInstanceId;
      request.settings.black = request.settings.white = { uri: "lan-engine:test-game", name: "AI" };
      request.settings.repeat = 2;
      request.settings.enableAutoSave = autoSave;
      const created = (await call("", request)) as GameSnapshot;
      await manager.get(created.sessionId).completion;
      expect(manager.get(created.sessionId).snapshot().results.total).toBe(2);
      const history = await getHistory();
      expect(history.entries).toHaveLength(2);
      for (const [index, entry] of history.entries.entries()) {
        expect(entry.class).toBe(HistoryClass.BACKUP_V2);
        if (entry.class !== HistoryClass.BACKUP_V2) throw new Error("Missing backup");
        expect(entry.title).toContain(`${index + 1}/2`);
        const record = importKIF(entry.kif) as Record;
        expect(record.length).toBe(5);
      }
    },
  );
});
