import { Hono } from "hono";
import { createGameSessionsClient } from "@/renderer/api/game_sessions";
import { GameSessionManager } from "@/server/game/manager";
import { createGameSessionRoutes } from "@/server/routes/game_sessions";
import { handleError } from "@/server/errors";
import { fakeGamePlayer, gameRequest, gameCommand } from "@/tests/server/helpers/game";

vi.mock("@/server/file/history", () => ({ saveBackup: vi.fn(), addHistory: vi.fn() }));

describe("typed game job client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("lists lightweight jobs and fences sockets and commands after transfer", async () => {
    const manager = new GameSessionManager({ playerBuilder: fakeGamePlayer().builder });
    const app = new Hono().route("/api/game-sessions", createGameSessionRoutes(manager));
    app.onError(handleError);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      app.request(input, init),
    );
    const client = createGameSessionsClient();
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    request.settings.black = { uri: "lan-engine:black", name: "Black" };
    request.settings.white = { uri: "lan-engine:white", name: "White" };
    const created = await client.create(request);
    const session = manager.get(created.sessionId);
    const close = vi.fn();
    session.connect("controller", () => {}, close, {
      connectionId: "first",
      controllerEpoch: 0,
      screenId: "original-document",
      recoveryId: created.controllerRecoveryId!,
    });
    const first = session.snapshot();
    expect(() =>
      session.connect(
        "controller",
        () => {},
        () => {},
        {
          connectionId: "copied-connection",
          controllerEpoch: first.controllerEpoch,
          screenId: "copied-document",
          recoveryId: first.controllerRecoveryId!,
        },
      ),
    ).toThrow(expect.objectContaining({ status: 423 }));
    expect(close).not.toHaveBeenCalled();
    const jobs = await client.list();
    expect(jobs).toMatchObject([{ id: session.id, kind: "game", attachment: { attached: true } }]);
    expect(jobs[0]).not.toHaveProperty("record");
    await expect(
      client.attach(session.id, {
        ownerId: "second",
        epoch: first.controllerEpoch,
        takeover: false,
        screenId: "screen",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const claimed = await client.attach(session.id, {
      ownerId: "second",
      epoch: first.controllerEpoch,
      takeover: true,
      screenId: "screen",
    });
    expect(close).toHaveBeenCalledWith(4001);
    await expect(client.command(session.id, gameCommand(first, "interrupt"))).rejects.toMatchObject(
      { status: 409 },
    );
    expect(() => session.connect("controller", () => {})).toThrow();
    session.connect(
      "second",
      () => {},
      () => {},
      {
        connectionId: "second-socket",
        controllerEpoch: claimed.controllerEpoch,
        screenId: "screen",
        recoveryId: claimed.controllerRecoveryId!,
      },
    );
    await client.detach(session.id, { ownerId: "controller", epoch: first.controllerEpoch });
    expect((await client.list())[0].attachment.attached).toBe(true);
    await client.command(
      session.id,
      gameCommand(session.snapshot(), "interrupt", { controllerId: "second" }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect((await client.list())[0].state).toBe("cancelled");
    await manager.close();
  });

  it("rejects malformed list responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ kind: "game" }])),
    );
    await expect(createGameSessionsClient().list()).rejects.toThrow();
  });
  it("cancels a parallel game without attachment and rejects cancellation of serial games", async () => {
    const manager = new GameSessionManager({ playerBuilder: fakeGamePlayer().builder });
    const app = new Hono()
      .route("/api/game-sessions", createGameSessionRoutes(manager))
      .onError(handleError);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      app.request(input, init),
    );
    const client = createGameSessionsClient();
    const request = gameRequest();
    request.serverInstanceId = manager.serverInstanceId;
    request.settings.black = request.settings.white = { uri: "lan-engine:test", name: "AI" };
    request.settings.parallelism = 2;
    request.settings.repeat = 3;
    const created = await client.create(request);
    await vi.advanceTimersByTimeAsync(1);
    const stopped = await client.cancel(created.sessionId);
    expect(stopped).toMatchObject({ id: created.sessionId, kind: "game", state: "cancelling" });
    await vi.advanceTimersByTimeAsync(1);
    await manager.get(created.sessionId).completion;
    expect((await client.list())[0].state).toBe("cancelled");
    const serial = await client.create({
      ...request,
      requestId: "serial",
      settings: { ...request.settings, parallelism: 1 },
    });
    await expect(client.cancel(serial.sessionId)).rejects.toMatchObject({ status: 409 });
    const closing = manager.close();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
  });
});
