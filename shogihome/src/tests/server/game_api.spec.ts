import { Hono } from "hono";
import { GameSessionManager } from "@/server/game/manager";
import { createGameSessionRoutes } from "@/server/routes/game_sessions";
import { handleError } from "@/server/errors";
import { gameRequest, gameCommand } from "./helpers/game";
import { Record } from "tsshogi";
import { decodeGameRequest } from "@/common/game/protocol";
import { MAX_SNAPSHOT_PLY } from "@/common/record/snapshot";

describe("game API boundary", () => {
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
    const manager = new GameSessionManager();
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
    session.connect("controller", () => {});
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
