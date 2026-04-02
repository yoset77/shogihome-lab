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

  it("stopAndWait should reject when the transport disconnects mid-stop", async () => {
    const player = new LanPlayer("research_main", "test-engine", "Test Engine");
    await launchPlayer(player);

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    await player.startResearch(record.position, usi);

    const stopPromise = player.stop();
    await vi.advanceTimersByTimeAsync(100);
    updateStatus("disconnected");

    await expect(stopPromise).rejects.toBeInstanceOf(Error);
  });

  it("should fail a stale ready state if bestmove replay never arrives", async () => {
    const onError = vi.fn();
    const player = new LanPlayer("test-session", "test-engine", "Test Engine", undefined, onError);
    await launchPlayer(player, { state: "thinking" });

    sendMsg({ state: "ready" });
    await vi.advanceTimersByTimeAsync(5001);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((player as unknown as { isThinking: boolean }).isThinking).toBe(false);
  });
});
