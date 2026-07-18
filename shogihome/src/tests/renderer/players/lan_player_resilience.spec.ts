import { LanEngine, LanEngineStatus } from "@/renderer/network/lan_engine";
import { LanPlayer, isActiveLanPlayerSession } from "@/renderer/players/lan_player";
import api from "@/renderer/ipc/api";
import { Record } from "tsshogi";
import { Mock } from "vitest";

vi.mock("@/renderer/network/lan_engine");
vi.mock("@/renderer/ipc/api");
vi.mock("@/renderer/players/usi_events");

describe("LanPlayer resilience", () => {
  let messageHandler: (message: string) => void;
  let messageListeners: ((message: string) => boolean)[] = [];
  let statusListeners: ((status: LanEngineStatus) => void)[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    messageListeners = [];
    statusListeners = [];

    (LanEngine.prototype.connect as Mock).mockImplementation(function (
      this: LanEngine,
      handler?: (message: string) => void,
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

    (LanEngine.prototype.sendCommand as Mock).mockImplementation(() => Promise.resolve());
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
    const json = JSON.stringify(msg);
    if (messageHandler) {
      messageHandler(json);
    }
    messageListeners.forEach((listener) => listener(json));
  }

  function updateStatus(status: LanEngineStatus) {
    statusListeners.forEach((listener) => listener(status));
  }

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
    await launchPromise;
  }

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
    await vi.advanceTimersByTimeAsync(16000);
    expect(resolved).toBe(false);
    expect(rejected).toBe(false);

    // Now simulate reconnection and stopped state frame
    updateStatus("connected");
    sendMsg({ state: "stopped", engineId: null });

    // It should still wait for bestmove
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    // Receive bestmove from replay buffer
    sendMsg({ info: "bestmove 7g7f", sfen: usi });
    await vi.advanceTimersByTimeAsync(100);

    await expect(stopPromise).resolves.toBeUndefined();
  });

  it("should pause stop acknowledgement timeout while disconnected and restart it after reconnect", async () => {
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

    await vi.advanceTimersByTimeAsync(16000);
    expect(rejected).toBe(false);

    (LanEngine.prototype.isConnected as Mock).mockReturnValue(true);
    updateStatus("connected");

    await vi.advanceTimersByTimeAsync(14999);
    expect(rejected).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(stopPromise).rejects.toThrow("Timed out waiting for stop acknowledgement");
    expect(rejected).toBe(true);
  });

  it("should fail a stale ready state if bestmove replay never arrives", async () => {
    const onError = vi.fn();
    const player = new LanPlayer(
      "test-session",
      "test-engine",
      "Test Engine",
      10,
      undefined,
      onError,
    );
    await launchPlayer(player, { state: "thinking", engineId: "test-engine" });

    sendMsg({ state: "ready", engineId: "test-engine" });
    await vi.advanceTimersByTimeAsync(5001);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((player as unknown as { isThinking: boolean }).isThinking).toBe(false);
  });

  it("should reject a queued search if state syncs to stopped and bestmove never arrives", async () => {
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

    // Simulate reconnection state frame
    sendMsg({ state: "stopped", engineId: null });

    // Wait for the readyReplayTimeout (5000ms)
    await vi.advanceTimersByTimeAsync(5001);

    await secondSearchResult;
    expect((player as unknown as { isThinking: boolean }).isThinking).toBe(false);
    expect(LanEngine.prototype.sendCommand).not.toHaveBeenCalledWith(secondUsi);
  });

  it("should close while a stop acknowledgement is waiting on a permanent disconnection", async () => {
    (LanEngine.prototype.sendCommand as Mock).mockImplementation(() => undefined);
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
    (LanEngine.prototype.sendCommand as Mock).mockImplementation(() => undefined);
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
    expect(LanEngine.prototype.sendCommand).not.toHaveBeenCalledWith(secondUsi);
  });

  it("should report an established idle session becoming uninitialized only once", async () => {
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

    sendMsg({ state: "uninitialized", engineId: null });
    sendMsg({ state: "uninitialized", engineId: null });

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
        considerBookMoveCount: true,
      },
    );
    await launchPlayer(player, { state: "ready", engineId: "test-engine" });
    expect(isActiveLanPlayerSession(200000)).toBe(true);

    sendMsg({ state: "uninitialized", engineId: null });
    await Promise.resolve();

    expect(isActiveLanPlayerSession(200000)).toBe(false);
    expect(api.closeBook).toHaveBeenCalledWith("test-book-session");
  });

  it("should keep a pending session-loss decision when a server error arrives first", async () => {
    const onError = vi.fn();
    const player = new LanPlayer(
      "research_main",
      "test-engine",
      "Test Engine",
      10,
      undefined,
      onError,
    );
    await launchPlayer(player, { state: "thinking", engineId: "test-engine" });

    sendMsg({ state: "uninitialized", engineId: null });
    sendMsg({ error: "engine not started" });

    expect(onError).toHaveBeenCalledOnce();
    await expect(
      player.startResearch(
        (Record.newByUSI("position startpos") as Record).position,
        "position startpos",
      ),
    ).rejects.toThrow();
  });

  it("should report a fatal error followed by stopped only once", async () => {
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
    sendMsg({ state: "stopped", engineId: null });

    expect(onError).toHaveBeenCalledOnce();
    await expect(
      player.startResearch(
        (Record.newByUSI("position startpos") as Record).position,
        "position startpos",
      ),
    ).rejects.toThrow();
  });

  it("should report stopped followed by a buffered fatal error only once", async () => {
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

    sendMsg({ state: "stopped", engineId: null });
    sendMsg({ error: "Engine did not respond to stop command. Session reset." });

    expect(onError).toHaveBeenCalledOnce();
  });

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

    await expect(launchPromise).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});
