import { LanEngine, LanEngineStatus } from "@/renderer/network/lan_engine";
import { LanPlayer, isActiveLanPlayerSession } from "@/renderer/players/lan_player";
import api from "@/renderer/ipc/api";
import { Record } from "tsshogi";
import { Mock } from "vitest";
import { BookMoveSelectionRule } from "@/common/settings/usi";
import type { BookMove } from "@/common/book";
import { decodeServerRelayMessage, type ServerRelayMessage } from "@/common/engine/relay_protocol";
import { t } from "@/common/i18n";
import { searchSnapshot } from "@/tests/helpers/engine_relay";

vi.mock("@/renderer/network/lan_engine");
vi.mock("@/renderer/ipc/api");
vi.mock("@/renderer/players/usi_events");

describe("LanPlayer resilience", () => {
  let messageHandler: (message: ServerRelayMessage) => void;
  let messageListeners: ((message: ServerRelayMessage) => boolean)[] = [];
  let statusListeners: ((status: LanEngineStatus) => void)[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    messageListeners = [];
    statusListeners = [];

    (LanEngine.prototype.connect as Mock).mockImplementation(function (
      this: LanEngine,
      handler?: (message: ServerRelayMessage) => void,
    ) {
      if (handler) {
        messageHandler = handler;
      }
      return Promise.resolve();
    });

    (LanEngine.prototype.addMessageListener as Mock).mockImplementation((listener) => {
      messageListeners.push(listener);
    });

    (LanEngine.prototype.removeMessageListener as Mock).mockImplementation((listener) => {
      messageListeners = messageListeners.filter((item) => item !== listener);
    });

    (LanEngine.prototype.subscribeStatus as Mock).mockImplementation((listener) => {
      statusListeners.push(listener);
      listener("disconnected");
      return () => {
        statusListeners = statusListeners.filter((item) => item !== listener);
      };
    });

    (LanEngine.prototype.startEngine as Mock).mockImplementation(() => {
      // noop
    });

    (LanEngine.prototype.sendUsiCommand as Mock).mockImplementation(() => Promise.resolve());
    (LanEngine.prototype.stopEngine as Mock).mockImplementation(() => undefined);
    (LanEngine.prototype.disconnect as Mock).mockImplementation(() => undefined);
    (LanEngine.prototype.isConnected as Mock).mockReturnValue(true);
    (api.openBookAsNewSession as Mock).mockResolvedValue("test-book-session");
    (api.closeBook as Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function sendMsg(msg: unknown) {
    const result = decodeServerRelayMessage(JSON.stringify(msg));
    if (!result.ok) throw new Error(result.error);
    messageListeners.forEach((listener) => listener(result.value));
    if (messageHandler) {
      messageHandler(result.value);
    }
  }

  function updateStatus(status: LanEngineStatus) {
    statusListeners.forEach((listener) => listener(status));
  }

  it("rejects searches without a session snapshot", async () => {
    const player = new LanPlayer("research_main", "test-engine", "Test");
    const record = Record.newByUSI("position startpos") as Record;

    await expect(player.startResearch(record.position, record.usi)).rejects.toThrow(
      t.engineProcessWasClosedUnexpectedly,
    );

    expect(LanEngine.prototype.sendSearch).not.toHaveBeenCalled();
    expect(LanEngine.prototype.sendUsiCommand).not.toHaveBeenCalled();
    await player.close();
  });

  it("cancels a hanging book lookup without blocking the next search or publishing its late result", async () => {
    const player = new LanPlayer("game_white", "test-engine", "Test", 10, undefined, undefined, {
      enabled: true,
      filePath: "test.db",
      moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_COUNT,
      scoreTemperature: 50,
    });
    await launchPlayer(player);
    const snapshot = searchSnapshot();
    sendMsg(snapshot);
    let finishBook!: (value: BookMove[]) => void;
    vi.mocked(api.searchBookMoves).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBook = resolve;
        }),
    );
    const record = Record.newByUSI("position startpos") as Record;
    const handler = { onMove: vi.fn(), onResign: vi.fn(), onWin: vi.fn(), onError: vi.fn() };
    const time = {
      black: { timeMs: 10000, byoyomi: 0, increment: 0 },
      white: { timeMs: 10000, byoyomi: 0, increment: 0 },
    };
    const search = player.startSearch(record.position, record.usi, time, handler);
    await vi.advanceTimersByTimeAsync(0);
    const cancel = player.cancelSearch();
    sendMsg({ ...snapshot, revision: 2 });
    await cancel;
    await search;
    vi.mocked(api.searchBookMoves).mockResolvedValue([]);
    await player.startSearch(record.position, record.usi, time, handler);
    expect(LanEngine.prototype.sendSearch).toHaveBeenCalledOnce();
    finishBook([{ usi: "7g7f", count: 1, comment: "" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler.onMove).not.toHaveBeenCalled();
    expect(LanEngine.prototype.sendSearch).toHaveBeenCalledOnce();
    await player.close();
  });

  async function launchPlayer(
    player: LanPlayer,
    msg: unknown = {
      state: "ready",
      engineId: (player as unknown as { engineId: string }).engineId,
    },
  ) {
    const launchPromise = player.launch();
    await vi.advanceTimersByTimeAsync(100);
    sendMsg(msg);
    sendMsg(searchSnapshot());
    await launchPromise;
  }

  it.each([
    { received: "no messages", messages: [] },
    {
      received: "starting state",
      messages: [{ state: "starting", engineId: "test-engine" }],
    },
    {
      received: "starting state and snapshot",
      messages: [{ state: "starting", engineId: "test-engine" }, searchSnapshot()],
    },
    { received: "ready state only", messages: [{ state: "ready", engineId: "test-engine" }] },
    { received: "snapshot only", messages: [searchSnapshot()] },
  ])("times out engine startup with $received", async ({ messages }) => {
    const player = new LanPlayer("research_main", "test-engine", "Test", 1);
    let launched = false;
    const launch = player.launch().then(() => {
      launched = true;
    });
    const result = expect(launch).rejects.toThrow(t.remoteEngineStartupTimedOut);
    await vi.advanceTimersByTimeAsync(0);
    messages.forEach(sendMsg);
    await vi.advanceTimersByTimeAsync(999);
    expect(launched).toBe(false);
    expect(LanEngine.prototype.sendUsiCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(LanEngine.prototype.stopEngine).toHaveBeenCalledOnce();
    expect(LanEngine.prototype.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["state first", "snapshot first"])(
    "waits for matching readiness and snapshot: %s",
    async (order) => {
      const player = new LanPlayer("research_main", "test-engine", "Test");
      let launched = false;
      const launch = player.launch().then(() => {
        launched = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      const state = { state: "ready", engineId: "test-engine" };
      const messages =
        order === "state first" ? [state, searchSnapshot()] : [searchSnapshot(), state];
      sendMsg(messages[0]);
      await vi.advanceTimersByTimeAsync(0);
      expect(launched).toBe(false);
      sendMsg(messages[1]);
      await launch;
      expect(player.supportsTakeback).toBe(true);
      await player.close();
    },
  );

  it("does not launch from another engine's snapshot", async () => {
    const player = new LanPlayer("research_main", "test-engine", "Test");
    let launched = false;
    const launch = player.launch().then(() => {
      launched = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    sendMsg(searchSnapshot({ engineId: "other-engine" }));
    sendMsg({ state: "ready", engineId: "test-engine" });
    await vi.advanceTimersByTimeAsync(0);
    expect(launched).toBe(false);
    sendMsg(searchSnapshot({ revision: 2 }));
    await launch;
    await player.close();
  });

  it("uses an initial snapshot received before connect resolves", async () => {
    vi.mocked(LanEngine.prototype.connect).mockImplementation(async (handler) => {
      messageHandler = handler!;
      sendMsg(searchSnapshot());
    });
    vi.mocked(LanEngine.prototype.startEngine).mockImplementation(() => {
      sendMsg({ state: "ready", engineId: "test-engine" });
    });
    const player = new LanPlayer("research_main", "test-engine", "Test");
    await player.launch();
    expect(player.supportsTakeback).toBe(true);
    await player.close();
  });

  it("does not combine pre-disconnect readiness with a replacement socket's snapshot", async () => {
    const player = new LanPlayer("research_main", "test-engine", "Test");
    let launched = false;
    const launch = player.launch().then(() => {
      launched = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    sendMsg({ state: "ready", engineId: "test-engine" });
    updateStatus("disconnected");
    updateStatus("connected");
    sendMsg(searchSnapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(launched).toBe(false);
    sendMsg({ state: "ready", engineId: "test-engine" });
    await launch;
    await player.close();
  });

  it("fails reconnect synchronization without a fresh snapshot despite matching output", async () => {
    const onError = vi.fn();
    const player = new LanPlayer("research_main", "test-engine", "Test", 1, undefined, onError);
    await launchPlayer(player);
    const record = Record.newByUSI("position startpos") as Record;
    await player.startResearch(record.position, record.usi);
    const stop = player.stop();
    const settled = vi.fn();
    void stop.then(settled, settled);
    await vi.advanceTimersByTimeAsync(0);
    updateStatus("disconnected");
    updateStatus("connected");
    sendMsg({ state: "ready", engineId: "test-engine" });
    sendMsg(searchSnapshot()); // A duplicate from the previous connection is not synchronization.
    sendMsg({ instanceId: "test-instance", searchId: 1, sfen: record.usi, info: "bestmove 7g7f" });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(stop).rejects.toThrow(t.engineProcessWasClosedUnexpectedly);
    expect(onError).toHaveBeenCalledOnce();
    expect(LanEngine.prototype.sendUsiCommand).not.toHaveBeenCalled();
    expect(player.supportsTakeback).toBe(false);
    await player.close();
  });

  it("does not report an error again when reconnect synchronization later times out", async () => {
    const onError = vi.fn();
    const player = new LanPlayer("research_main", "test-engine", "Test", 1, undefined, onError);
    await launchPlayer(player);
    updateStatus("disconnected");
    updateStatus("connected");
    sendMsg({ error: "Engine failed" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("Engine failed"));
    expect(player.supportsTakeback).toBe(false);
    await player.close();
  });

  it("aborts a pending book search when its snapshot reports session loss", async () => {
    const onError = vi.fn();
    const player = new LanPlayer("game_white", "test-engine", "Test", 10, undefined, onError, {
      enabled: true,
      filePath: "test.db",
      moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_COUNT,
      scoreTemperature: 50,
    });
    await launchPlayer(player);
    const book = Promise.withResolvers<BookMove[]>();
    vi.mocked(api.searchBookMoves).mockReturnValueOnce(book.promise);
    const record = Record.newByUSI("position startpos") as Record;
    const handler = { onMove: vi.fn(), onResign: vi.fn(), onWin: vi.fn(), onError: vi.fn() };
    const search = player.startSearch(
      record.position,
      record.usi,
      {
        black: { timeMs: 10000, byoyomi: 0, increment: 0 },
        white: { timeMs: 10000, byoyomi: 0, increment: 0 },
      },
      handler,
    );
    await vi.advanceTimersByTimeAsync(0);
    sendMsg(searchSnapshot({ instanceId: "next-instance", engineId: null }));
    await search;
    book.resolve([{ usi: "7g7f", count: 1, comment: "" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler.onMove).not.toHaveBeenCalled();
    expect(handler.onError).toHaveBeenCalledOnce();
    expect(LanEngine.prototype.sendSearch).not.toHaveBeenCalled();
    await player.close();
  });

  it.each([
    {},
    { instanceId: "old-instance", searchId: 1 },
    { instanceId: "test-instance", searchId: 2 },
  ])("ignores raw or unrelated results for the same position: %j", async (identity) => {
    const player = new LanPlayer("research_main", "test-engine", "Test");
    await launchPlayer(player);
    const record = Record.newByUSI("position startpos") as Record;
    await player.startResearch(record.position, record.usi);
    const stop = player.stop();
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    sendMsg({ ...identity, sfen: record.usi, info: "bestmove 7g7f" });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    sendMsg({ instanceId: "test-instance", searchId: 1, sfen: record.usi, info: "bestmove 7g7f" });
    await stop;
    expect(LanEngine.prototype.stopSearch).toHaveBeenCalledExactlyOnceWith({
      type: "stopSearch",
      instanceId: "test-instance",
      searchId: 1,
    });
    expect(LanEngine.prototype.sendUsiCommand).not.toHaveBeenCalled();
    await player.close();
  });

  it("stopAndWait should NOT reject when the transport disconnects mid-stop", async () => {
    const player = new LanPlayer("research_main", "test-engine", "Test Engine");
    await launchPlayer(player);

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    await player.startResearch(record.position, usi);

    const stopPromise = player.stop();
    await vi.advanceTimersByTimeAsync(100);
    updateStatus("disconnected");

    // It should still be pending
    let resolved = false;
    let rejected = false;
    stopPromise.then(() => {
      resolved = true;
    });
    stopPromise.catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(31000);
    expect(resolved).toBe(false);
    expect(rejected).toBe(false);

    // Now simulate reconnection and stopped state frame
    updateStatus("connected");
    sendMsg({ state: "stopped", engineId: null });

    // It should still wait for bestmove
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    // The authoritative snapshot recovers the result, regardless of raw state replay.
    sendMsg(
      searchSnapshot({
        revision: 2,
        accepted: 1,
        terminal: { searchId: 1, position: usi, output: "bestmove 7g7f", delay: 1000 },
      }),
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(stopPromise).resolves.toBeUndefined();
  });

  it("restarts the stop deadline only after the replacement socket's snapshot", async () => {
    (LanEngine.prototype.isConnected as Mock).mockReturnValue(false);
    const player = new LanPlayer("research_main", "test-engine", "Test Engine");
    await launchPlayer(player);

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    await player.startResearch(record.position, usi);

    const stopPromise = player.stop();
    let rejected = false;
    stopPromise.catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(31000);
    expect(rejected).toBe(false);

    (LanEngine.prototype.isConnected as Mock).mockReturnValue(true);
    updateStatus("connected");

    await vi.advanceTimersByTimeAsync(5000);
    expect(rejected).toBe(false);
    sendMsg(searchSnapshot({ revision: 2, accepted: 1, active: 1 }));

    await vi.advanceTimersByTimeAsync(29999);
    expect(rejected).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(stopPromise).rejects.toThrow("Timed out waiting for stop acknowledgement");
    expect(rejected).toBe(true);
  });

  it("should pause stop acknowledgement timeout while refreshing the transport", async () => {
    const player = new LanPlayer("research_main", "test-engine", "Test Engine");
    await launchPlayer(player);
    updateStatus("connected");

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    await player.startResearch(record.position, usi);

    const stopPromise = player.stop();
    let rejected = false;
    stopPromise.catch(() => {
      rejected = true;
    });
    const stopResult = expect(stopPromise).rejects.toThrow(
      "Timed out waiting for stop acknowledgement",
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(
      (player as unknown as { stopPromiseTimeoutId: number | null }).stopPromiseTimeoutId,
    ).not.toBeNull();
    updateStatus("connecting");
    expect(
      (player as unknown as { stopPromiseTimeoutId: number | null }).stopPromiseTimeoutId,
    ).toBe(null);

    await vi.advanceTimersByTimeAsync(31000);
    expect(rejected).toBe(false);
    expect(
      (player as unknown as { stopPromiseTimeoutId: number | null }).stopPromiseTimeoutId,
    ).toBe(null);

    updateStatus("connected");
    sendMsg(searchSnapshot({ revision: 2, accepted: 1, active: 1 }));
    await vi.advanceTimersByTimeAsync(30000);
    await stopResult;
  });

  it("does not infer search completion or failure from replayed raw states", async () => {
    const onError = vi.fn();
    const player = new LanPlayer(
      "test-session",
      "test-engine",
      "Test Engine",
      10,
      undefined,
      onError,
    );
    await launchPlayer(player);
    const record = Record.newByUSI("position startpos") as Record;
    await player.startResearch(record.position, record.usi);

    for (const state of ["ready", "uninitialized", "stopped"]) {
      sendMsg({ state, engineId: state === "ready" ? "test-engine" : null });
    }
    await vi.advanceTimersByTimeAsync(5001);

    expect(onError).not.toHaveBeenCalled();
    expect((player as unknown as { isThinking: boolean }).isThinking).toBe(true);
    await player.close();
  });

  it("rejects a queued search when a snapshot reports that its engine is gone", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    await launchPlayer(player);

    const firstUsi = "position startpos moves 7g7f";
    const secondUsi = "position startpos moves 2g2f";
    const firstRecord = Record.newByUSI(firstUsi) as Record;
    const secondRecord = Record.newByUSI(secondUsi) as Record;
    await player.startResearch(firstRecord.position, firstUsi);

    const secondSearch = player.startResearch(secondRecord.position, secondUsi);
    const secondSearchResult = expect(secondSearch).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);

    sendMsg(searchSnapshot({ instanceId: "next-instance", engineId: null }));

    await secondSearchResult;
    expect((player as unknown as { isThinking: boolean }).isThinking).toBe(false);
    expect(LanEngine.prototype.sendSearch).not.toHaveBeenCalledWith(
      expect.objectContaining({ position: secondUsi }),
    );
  });

  it("should close while a stop acknowledgement is waiting on a permanent disconnection", async () => {
    vi.mocked(LanEngine.prototype.stopSearch).mockImplementation(() => {});
    const player = new LanPlayer("research_main", "test-engine", "Test Engine");
    await launchPlayer(player);

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    await player.startResearch(record.position, usi);

    const stopPromise = player.stop();
    await vi.advanceTimersByTimeAsync(100);
    (LanEngine.prototype.isConnected as Mock).mockReturnValue(false);
    updateStatus("disconnected");

    const closePromise = player.close();
    await vi.advanceTimersByTimeAsync(100);

    await expect(stopPromise).resolves.toBeUndefined();
    await expect(closePromise).resolves.toBeUndefined();
    expect(LanEngine.prototype.terminateEngine).toHaveBeenCalledOnce();
  });

  it("should not resume a queued search after close cancels its stop wait", async () => {
    vi.mocked(LanEngine.prototype.stopSearch).mockImplementation(() => {});
    const player = new LanPlayer("research_main", "test-engine", "Test Engine");
    await launchPlayer(player);

    const firstUsi = "position startpos moves 7g7f";
    const secondUsi = "position startpos moves 2g2f";
    const firstRecord = Record.newByUSI(firstUsi) as Record;
    const secondRecord = Record.newByUSI(secondUsi) as Record;
    await player.startResearch(firstRecord.position, firstUsi);

    const secondSearch = player.startResearch(secondRecord.position, secondUsi);
    const secondSearchResult = expect(secondSearch).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    (LanEngine.prototype.isConnected as Mock).mockReturnValue(false);
    updateStatus("disconnected");

    const closePromise = player.close();
    await vi.advanceTimersByTimeAsync(100);

    await secondSearchResult;
    await expect(closePromise).resolves.toBeUndefined();
    expect(LanEngine.prototype.sendSearch).not.toHaveBeenCalledWith(
      expect.objectContaining({ position: secondUsi }),
    );
  });

  it("reports replacement of an established idle session only once", async () => {
    const onError = vi.fn();
    const player = new LanPlayer(
      "research_main",
      "test-engine",
      "Test Engine",
      10,
      undefined,
      onError,
    );
    await launchPlayer(player, { state: "ready", engineId: "test-engine" });

    sendMsg(searchSnapshot({ instanceId: "next-instance", engineId: null }));
    sendMsg(searchSnapshot({ instanceId: "next-instance", engineId: null, revision: 2 }));

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("should release owned resources when an established session is lost", async () => {
    const player = new LanPlayer(
      "research_main",
      "test-engine",
      "Test Engine",
      10,
      undefined,
      undefined,
      {
        enabled: true,
        filePath: "test.db",
        moveSelectionRule: BookMoveSelectionRule.WEIGHTED_BY_COUNT,
        scoreTemperature: 50,
      },
    );
    await launchPlayer(player, { state: "ready", engineId: "test-engine" });
    expect(isActiveLanPlayerSession(200000)).toBe(true);

    sendMsg(searchSnapshot({ instanceId: "next-instance", engineId: null }));
    await Promise.resolve();

    expect(isActiveLanPlayerSession(200000)).toBe(false);
    expect(api.closeBook).toHaveBeenCalledWith("test-book-session");
  });

  it("does not report a buffered error again after a snapshot reports session loss", async () => {
    const onError = vi.fn();
    const player = new LanPlayer(
      "research_main",
      "test-engine",
      "Test Engine",
      10,
      undefined,
      onError,
    );
    await launchPlayer(player);

    sendMsg(searchSnapshot({ instanceId: "next-instance", engineId: null }));
    sendMsg({ error: "engine not started" });

    expect(onError).toHaveBeenCalledOnce();
    await expect(
      player.startResearch(
        (Record.newByUSI("position startpos") as Record).position,
        "position startpos",
      ),
    ).rejects.toThrow();
  });

  it("reports a fatal error followed by a stopped snapshot only once", async () => {
    const onError = vi.fn();
    const player = new LanPlayer(
      "research_main",
      "test-engine",
      "Test Engine",
      10,
      undefined,
      onError,
    );
    await launchPlayer(player, { state: "ready", engineId: "test-engine" });

    sendMsg({ error: "Engine did not respond to stop command. Session reset." });
    sendMsg(searchSnapshot({ instanceId: "next-instance", engineId: null }));

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      new Error("Engine did not respond to stop command. Session reset."),
    );
    await expect(
      player.startResearch(
        (Record.newByUSI("position startpos") as Record).position,
        "position startpos",
      ),
    ).rejects.toThrow();
  });

  it.each([t.resourceGroupCapacity("CPU", 8, 6, 4), "Engine startup failed"])(
    "reports startup errors only through the launch promise: %s",
    async (message) => {
      const onError = vi.fn();
      const player = new LanPlayer(
        "research_main",
        "test-engine",
        "Test Engine",
        10,
        undefined,
        onError,
      );
      const launchPromise = player.launch();
      const result = expect(launchPromise).rejects.toThrow(message);
      await vi.advanceTimersByTimeAsync(100);

      sendMsg({ error: message });

      await result;
      expect(onError).not.toHaveBeenCalled();
      expect(isActiveLanPlayerSession(player.sessionID)).toBe(false);
      expect(LanEngine.prototype.stopEngine).toHaveBeenCalledOnce();
      expect(LanEngine.prototype.disconnect).toHaveBeenCalledOnce();
    },
  );

  it("should accept uninitialized and starting states while launching", async () => {
    const onError = vi.fn();
    const player = new LanPlayer(
      "research_main",
      "test-engine",
      "Test Engine",
      10,
      undefined,
      onError,
    );
    const launchPromise = player.launch();
    await vi.advanceTimersByTimeAsync(100);

    sendMsg({ state: "uninitialized", engineId: null });
    sendMsg({ state: "starting", engineId: "test-engine" });
    sendMsg({ state: "ready", engineId: "test-engine" });
    sendMsg(searchSnapshot());

    await expect(launchPromise).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});
