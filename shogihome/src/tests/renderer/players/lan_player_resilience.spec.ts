import { LanEngine, LanEngineStatus } from "@/renderer/network/lan_engine";
import { LanPlayer } from "@/renderer/players/lan_player";
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

  async function launchPlayer(player: LanPlayer, msg: unknown = { info: "info: engine is ready" }) {
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
    stopPromise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    // Now simulate reconnection and stopped state frame
    updateStatus("connected");
    sendMsg({ state: "stopped" });

    // It should still wait for bestmove
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    // Receive bestmove from replay buffer
    sendMsg({ info: "bestmove 7g7f", sfen: usi });
    await vi.advanceTimersByTimeAsync(100);

    await expect(stopPromise).resolves.toBeUndefined();
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
    await launchPlayer(player, { state: "thinking" });

    sendMsg({ state: "ready" });
    await vi.advanceTimersByTimeAsync(5001);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((player as unknown as { isThinking: boolean }).isThinking).toBe(false);
  });

  it("should resolve stop promise if state syncs to stopped and bestmove never arrives", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    await launchPlayer(player);

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    await player.startResearch(record.position, usi);

    const stopPromise = player.stop();
    await vi.advanceTimersByTimeAsync(100);

    // Simulate reconnection state frame
    sendMsg({ state: "stopped" });

    // Wait for the readyReplayTimeout (5000ms)
    await vi.advanceTimersByTimeAsync(5001);

    await expect(stopPromise).resolves.toBeUndefined();
    expect((player as unknown as { isThinking: boolean }).isThinking).toBe(false);
  });
});
