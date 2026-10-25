import { Hono } from "hono";
import { GameSessionManager } from "@/server/game/manager";
import { createGameSessionRoutes } from "@/server/routes/game_sessions";
import { handleError } from "@/server/errors";
import { gameRequest, gameCommand, fakeGamePlayer, connectGame } from "./helpers/game";
import { Record } from "tsshogi";
import { decodeGameRequest } from "@/common/game/protocol";
import { MAX_SNAPSHOT_PLY } from "@/common/record/snapshot";

vi.mock("@/server/file/history", () => ({
  saveBackup: vi.fn().mockResolvedValue(undefined),
  addHistory: vi.fn().mockResolvedValue(undefined),
}));

describe("game API boundary", () => {
  it.each([false, true])(
    "accepts a single normalized destination with auto-save=%s",
    (enableAutoSave) => {
      const request = gameRequest();
      request.settings.enableAutoSave = enableAutoSave;
      request.settings.autoSaveDirectory = "server://selected///";
      const decoded = decodeGameRequest(request);
      expect(decoded).toMatchObject({
        ok: true,
        value: {
          settings: { autoSaveDirectory: "server://selected" },
        },
      });
      if (!decoded.ok) throw new Error(decoded.error);
      expect(decoded.value.options.save).not.toHaveProperty("directory");
    },
  );

  it("ignores the retired save option instead of overriding the game destination", () => {
    const request = gameRequest();
    request.settings.autoSaveDirectory = "server://selected";
    const decoded = decodeGameRequest({
      ...request,
      options: {
        ...request.options,
        save: { ...request.options.save, directory: "server://other" },
      },
    });
    expect(decoded).toMatchObject({
      ok: true,
      value: { settings: { autoSaveDirectory: "server://selected" } },
    });
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.value.options.save).not.toHaveProperty("directory");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["number", 1],
    ["oversized", "x".repeat(2049)],
  ])("rejects %s game destinations", (_label, autoSaveDirectory) => {
    const request = gameRequest();
    expect(
      decodeGameRequest({ ...request, settings: { ...request.settings, autoSaveDirectory } }).ok,
    ).toBe(false);
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("reserves capacity for termination when starting at the maximum ply", () => {
    const record = Record.newByUSI(
      "position startpos moves " + "5i5h 5a5b 5h5i 5b5a ".repeat(MAX_SNAPSHOT_PLY / 4).trim(),
    ) as Record;
    const request = gameRequest(record);
    request.settings.startPosition = "current";
    expect(decodeGameRequest(request).ok).toBe(false);
  });
  function setup() {
    const manager = new GameSessionManager({ playerBuilder: fakeGamePlayer().builder });
    const app = new Hono().route("/api/game-sessions", createGameSessionRoutes(manager));
    app.onError(handleError);
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    const post = (body: unknown) =>
      app.request("/api/game-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    return { manager, app, request, post };
  }
  it.each([false, true])(
    "rejects legacy requests without a game destination with auto-save=%s",
    async (enableAutoSave) => {
      const { manager, request, post } = setup();
      try {
        const response = await post({
          ...request,
          settings: { ...request.settings, enableAutoSave, autoSaveDirectory: undefined },
          options: { ...request.options, save: { ...request.options.save, directory: "" } },
        });
        expect(response.status).toBe(400);
      } finally {
        await manager.close();
      }
    },
  );

  it.each([false, true])(
    "never exposes control credentials in public responses ai=%s",
    async (ai) => {
      const manager = new GameSessionManager({ playerBuilder: fakeGamePlayer().builder });
      const request = gameRequest();
      request.serverInstanceId = manager.serverInstanceId;
      if (ai)
        request.settings.black = request.settings.white = { uri: "lan-engine:test", name: "AI" };
      const session = await manager.create(request);
      await vi.advanceTimersByTimeAsync(0);
      connectGame(session);
      const app = new Hono().route("/api/game-sessions", createGameSessionRoutes(manager));
      app.onError(handleError);
      const responses = [
        await app.request(`/api/game-sessions/${session.id}`),
        await app.request(`/api/game-sessions/by-request/${request.requestId}`),
      ];
      if (ai)
        responses.push(
          await app.request(`/api/game-sessions/${session.id}/detach`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerId: "unrelated", epoch: 0, screenId: "unrelated" }),
          }),
        );
      try {
        for (const response of responses) {
          expect(response.status).toBe(200);
          const snapshot = await response.json();
          expect(snapshot).not.toHaveProperty("controllerOwnerId");
          expect(snapshot).not.toHaveProperty("controllerRecoveryId");
          expect(snapshot).not.toHaveProperty("controllerConnectionId");
          expect(snapshot.controllerGeneration).toBeTypeOf("number");
        }
      } finally {
        const closing = manager.close();
        await vi.advanceTimersByTimeAsync(10);
        await closing;
      }
    },
  );
  it("authenticates recovery and prevents public snapshots from authorizing a human move", async () => {
    const manager = new GameSessionManager({ playerBuilder: fakeGamePlayer().builder });
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    const session = await manager.create(request);
    await vi.advanceTimersByTimeAsync(0);
    const connection = connectGame(session);
    await session.command(gameCommand(session.snapshot(), "resume"));
    const app = new Hono().route("/api/game-sessions", createGameSessionRoutes(manager));
    app.onError(handleError);
    const post = (path: string, body: unknown) =>
      app.request(`/api/game-sessions/${session.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const snapshot = await (await app.request(`/api/game-sessions/${session.id}`)).json();
      expect(
        (
          await post(
            "commands",
            gameCommand(snapshot, "move", { controllerId: "unrelated", move: "7g7f" }),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await post("attached-snapshot", {
            ownerId: "unrelated",
            epoch: snapshot.controllerEpoch,
            screenId: "copy",
            takeover: false,
          })
        ).status,
      ).toBe(409);
      const current = session.snapshot();
      expect(
        (
          await post("attached-snapshot", {
            ownerId: "controller",
            epoch: current.controllerEpoch,
            screenId: "screen",
            takeover: false,
          })
        ).status,
      ).toBe(409);
      const recovery = {
        ownerId: "controller",
        epoch: current.controllerEpoch,
        recoveryId: current.controllerRecoveryId,
        screenId: "copy",
        takeover: false,
      };
      expect((await post("attached-snapshot", recovery)).status).toBe(423);
      connection.disconnect();
      const owned = await (await post("attached-snapshot", recovery)).json();
      expect(owned.controllerRecoveryId).toBe(current.controllerRecoveryId);
      expect(owned.controllerEpoch).toBeGreaterThan(current.controllerEpoch);
      expect(owned.controllerGeneration).toBe(current.controllerGeneration);
    } finally {
      const closing = manager.close();
      await vi.advanceTimersByTimeAsync(10);
      await closing;
    }
  });
  it("does not expose a new owner's credentials on a retried creation", async () => {
    const { manager, request, post } = setup();
    request.settings.black = request.settings.white = { uri: "lan-engine:test", name: "AI" };
    const response = await post(request);
    const created = await response.json();
    const session = manager.get(created.sessionId);
    session.attach({ ownerId: "new-owner", epoch: 0, screenId: "new-screen", takeover: false });
    const retried = await (await post(request)).json();
    expect(retried).not.toHaveProperty("controllerOwnerId");
    expect(retried).not.toHaveProperty("controllerRecoveryId");
    expect(retried.controllerGeneration).toBeGreaterThan(created.controllerGeneration);
    const closing = manager.close();
    await vi.advanceTimersByTimeAsync(10);
    await closing;
  });
  it("creates idempotently and rejects concurrent, conflicting and expired requests", async () => {
    const { manager, request, post, app } = setup();
    const response = await post(request);
    const snapshot = await response.json();
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await (await post(request)).json()).sessionId).toBe(snapshot.sessionId);
    expect((await post({ ...request, requestId: "other" })).status).toBe(503);
    expect(
      (await post({ ...request, settings: { ...request.settings, maxMoves: 1 } })).status,
    ).toBe(409);
    expect((await post({ ...request, serverInstanceId: "old" })).status).toBe(410);
    expect((await app.request("/api/game-sessions/by-request/unknown")).status).toBe(410);
    expect((await app.request("/api/game-sessions/unknown")).status).toBe(410);
    const session = manager.get(snapshot.sessionId);
    connectGame(session);
    const command = gameCommand(session.snapshot(), "interrupt");
    const cancelled = await app.request(`/api/game-sessions/${session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(cancelled.status).toBe(200);
    await vi.advanceTimersByTimeAsync(10);
    await manager.close();
  });
  it.each([null, [], {}, { settings: {} }])("rejects invalid object bodies: %j", async (input) => {
    expect((await setup().post(input)).status).toBe(400);
  });
  it.each(["es://basic-engine/random", "es://usi-engine/native", "lan-engine:bad\nquit"])(
    "rejects unsupported players: %s",
    async (uri) => {
      const { request, post } = setup();
      request.settings.black.uri = uri;
      expect((await post(request)).status).toBe(400);
    },
  );
  it("rejects unbounded time, repeats, incompatible clocks, malformed trees and non-server positions", async () => {
    const { request, post } = setup();
    for (const time of [-1, "10", null, 100_000])
      expect(
        (
          await post({
            ...request,
            settings: {
              ...request.settings,
              timeLimit: { ...request.settings.timeLimit, timeSeconds: time },
            },
          })
        ).status,
      ).toBe(400);
    expect((await post({ ...request, settings: { ...request.settings, repeat: 2 } })).status).toBe(
      400,
    );
    expect(
      (
        await post({
          ...request,
          settings: {
            ...request.settings,
            timeLimit: { timeSeconds: 30, byoyomi: 10, increment: 2 },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          ...request,
          settings: {
            ...request.settings,
            startPosition: "list",
            startPositionListFile: "/local.sfen",
          },
        })
      ).status,
    ).toBe(400);
    request.source.nodes[0].parentId = "wrong";
    expect((await post(request)).status).toBe(400);
  });
  it("rejects malformed JSON and excessive input before session creation", async () => {
    const { app } = setup();
    const headers = { "Content-Type": "application/json" };
    expect(
      (await app.request("/api/game-sessions", { method: "POST", headers, body: "{" })).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/game-sessions", {
          method: "POST",
          headers,
          body: " ".repeat(10 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
  });
});
