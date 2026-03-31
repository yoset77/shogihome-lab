import { LanPlayer, isActiveLanPlayerSession } from "@/renderer/players/lan_player";
import { LanEngine } from "@/renderer/network/lan_engine";
import { Record } from "tsshogi";
import { Mock } from "vitest";
import api from "@/renderer/ipc/api";
import { dispatchUSIInfoUpdate, triggerOnStartSearch } from "@/renderer/players/usi_events";

vi.mock("@/renderer/network/lan_engine");
vi.mock("@/renderer/ipc/api");
vi.mock("@/renderer/players/usi_events");

describe("LanPlayer", () => {
  let messageHandler: (message: string) => void;
  let messageListeners: ((message: string) => boolean)[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    messageListeners = [];

    // Mock API
    (api.searchBookMoves as Mock).mockResolvedValue([]);
    (api.openBookAsNewSession as Mock).mockResolvedValue("test-book-session");

    // Functional mock for connect
    (LanEngine.prototype.connect as Mock).mockImplementation(function (
      this: LanEngine,
      handler?: (message: string) => void,
    ) {
      if (handler) {
        messageHandler = handler;
      }
      return Promise.resolve();
    });

    // Functional mock for adding listeners
    (LanEngine.prototype.addMessageListener as Mock).mockImplementation((l) => {
      messageListeners.push(l);
    });

    // Functional mock for removing listeners
    (LanEngine.prototype.removeMessageListener as Mock).mockImplementation((l) => {
      messageListeners = messageListeners.filter((item) => item !== l);
    });

    // Mock startEngine
    (LanEngine.prototype.startEngine as Mock).mockImplementation(() => {
      // noop
    });

    // Mock sendCommand to automatically resolve stopAndWait
    (LanEngine.prototype.sendCommand as Mock).mockImplementation((cmd: string) => {
      if (cmd === "stop") {
        setTimeout(() => {
          sendMsg({ info: "bestmove 7g7f" });
        }, 10);
      }
      return Promise.resolve();
    });
    (LanEngine.prototype.setOption as Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function sendMsg(msg: unknown) {
    const json = JSON.stringify(msg);
    if (messageHandler) {
      messageHandler(json);
    }
    messageListeners.forEach((l) => l(json));
  }

  async function launchPlayer(player: LanPlayer, msg: unknown = { info: "info: engine is ready" }) {
    const launchPromise = player.launch();
    await vi.advanceTimersByTimeAsync(100);
    sendMsg(msg);
    await launchPromise;
  }

  it("updateInfo should filter multipv > 1 and use throttling", async () => {
    const onSearchInfo = vi.fn();
    const player = new LanPlayer("test-session", "test-engine", "Test Engine", onSearchInfo);

    await launchPlayer(player);

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    await player.startResearch(record.position, usi);

    // PV1
    messageHandler(
      JSON.stringify({
        sfen: usi,
        info: "info depth 10 multipv 1 score cp 100 pv 7g7f",
      }),
    );

    // Should not call onSearchInfo immediately due to throttling
    expect(onSearchInfo).not.toBeCalled();

    // Advance time
    vi.advanceTimersByTime(500);
    expect(onSearchInfo).toBeCalledTimes(1);
    expect(onSearchInfo).toBeCalledWith(expect.objectContaining({ score: 100 }));

    onSearchInfo.mockClear();

    // PV2
    messageHandler(
      JSON.stringify({
        sfen: usi,
        info: "info depth 10 multipv 2 score cp 80 pv 2g2f",
      }),
    );

    // Advance time
    vi.advanceTimersByTime(500);
    // Should NOT be called for multipv 2
    expect(onSearchInfo).not.toBeCalled();

    // PV1 again with updated score
    messageHandler(
      JSON.stringify({
        sfen: usi,
        info: "info depth 11 multipv 1 score cp 120 pv 7g7f",
      }),
    );
    vi.advanceTimersByTime(500);
    expect(onSearchInfo).toBeCalledTimes(1);
    expect(onSearchInfo).toBeCalledWith(expect.objectContaining({ score: 120 }));
  });

  it("updateInfo should ignore stale messages with wrong SFEN", async () => {
    const onSearchInfo = vi.fn();
    const player = new LanPlayer("test-session", "test-engine", "Test Engine", onSearchInfo);

    await launchPlayer(player);

    const usi1 = "position startpos moves 7g7f";
    const usi2 = "position startpos moves 7g7f 3c3d";
    const record1 = Record.newByUSI(usi1) as Record;
    const record2 = Record.newByUSI(usi2) as Record;

    // Start search on position 1
    const p1 = player.startResearch(record1.position, usi1);
    await vi.runAllTimersAsync();
    await p1;

    // Position changes to 2
    const p2 = player.startResearch(record2.position, usi2);
    // Simulate bestmove for position 1 to resolve stopAndWait
    sendMsg({ info: "bestmove 7g7f" });
    await vi.runAllTimersAsync();
    await p2;

    // Stale message from position 1 arrives
    messageHandler(
      JSON.stringify({
        sfen: usi1,
        info: "info depth 10 multipv 1 score cp 100 pv 3c3d",
      }),
    );

    // Message with null SFEN arrives
    messageHandler(
      JSON.stringify({
        sfen: null,
        info: "info depth 10 multipv 1 score cp 100 pv 3c3d",
      }),
    );

    vi.advanceTimersByTime(500);
    // Both should be ignored
    expect(onSearchInfo).not.toBeCalled();

    // Correct message for position 2 arrives
    messageHandler(
      JSON.stringify({
        sfen: usi2,
        info: "info depth 10 multipv 1 score cp 50 pv 2g2f",
      }),
    );
    vi.advanceTimersByTime(500);
    expect(onSearchInfo).toBeCalledWith(expect.objectContaining({ score: 50 }));
  });

  it("updateInfo should not flush pending info after position change", async () => {
    const onSearchInfo = vi.fn();
    const player = new LanPlayer("test-session", "test-engine", "Test Engine", onSearchInfo);

    await launchPlayer(player);

    const usi1 = "position startpos moves 7g7f";
    const usi2 = "position startpos moves 7g7f 3c3d";
    const record1 = Record.newByUSI(usi1) as Record;
    const record2 = Record.newByUSI(usi2) as Record;

    // Start search on position 1
    const p1 = player.startResearch(record1.position, usi1);
    await vi.runAllTimersAsync();
    await p1;

    // Info for position 1 arrives and is throttled
    messageHandler(
      JSON.stringify({
        sfen: usi1,
        info: "info depth 10 multipv 1 score cp 100 pv 3c3d",
      }),
    );
    expect(onSearchInfo).not.toBeCalled();

    // Position changes to 2 before throttle expires
    const p2 = player.startResearch(record2.position, usi2);
    // Simulate bestmove for position 1 to resolve stopAndWait
    sendMsg({
      sfen: usi1, // Server still tags it with old SFEN
      info: "bestmove 7g7f",
    });
    await vi.runAllTimersAsync();
    await p2;

    // Advance time to trigger throttle
    vi.advanceTimersByTime(500);

    // Should NOT be called with info from position 1
    expect(onSearchInfo).not.toBeCalled();
  });

  it("dispatchUSIInfoUpdate should be called even for multipv > 1", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine", () => {
      /* noop */
    });

    await launchPlayer(player);

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    const p1 = player.startResearch(record.position, usi);
    await vi.runAllTimersAsync();
    await p1;

    // PV2
    messageHandler(
      JSON.stringify({
        sfen: usi,
        info: "info depth 10 multipv 2 score cp 80 pv 2g2f",
      }),
    );

    // dispatchUSIInfoUpdate should be called for UI display
    expect(dispatchUSIInfoUpdate).toBeCalled();
  });

  it("should resolve launch and set isThinking to true when re-attaching to a thinking engine", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    await launchPlayer(player, { state: "thinking" });

    // Check if isThinking is true
    expect((player as unknown as { isThinking: boolean }).isThinking).toBe(true);
  });

  it("should use deterministic sessionID", () => {
    const playerMain = new LanPlayer("research_main", "test-engine", "Test Engine");
    expect(playerMain.sessionID).toBe(200000);

    const playerSub1 = new LanPlayer("research_sub_1", "test-engine", "Test Engine");
    expect(playerSub1.sessionID).toBe(200001);

    const playerSub2 = new LanPlayer("research_sub_2", "test-engine", "Test Engine");
    expect(playerSub2.sessionID).toBe(200002);
  });

  it("isActiveLanPlayerSession should track active sessions", async () => {
    const player = new LanPlayer("research_main", "test-engine", "Test Engine");
    expect(isActiveLanPlayerSession(200000)).toBe(false);

    await launchPlayer(player);

    expect(isActiveLanPlayerSession(200000)).toBe(true);

    await player.close();
    expect(isActiveLanPlayerSession(200000)).toBe(false);
  });

  it("should trigger onStartSearch when starting search or research", async () => {
    const player = new LanPlayer("research_main", "test-engine", "Test Engine");
    await launchPlayer(player);

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;

    // Test startResearch
    const p1 = player.startResearch(record.position, usi);
    await vi.runAllTimersAsync();
    await p1;
    expect(triggerOnStartSearch).toBeCalledWith(200000, record.position);

    (triggerOnStartSearch as Mock).mockClear();

    // Test startSearch
    const p2 = player.startSearch(
      record.position,
      usi,
      {
        black: { timeMs: 1000, byoyomi: 0, increment: 0 },
        white: { timeMs: 1000, byoyomi: 0, increment: 0 },
      },
      {
        onMove: vi.fn(),
        onResign: vi.fn(),
        onWin: vi.fn(),
        onError: vi.fn(),
      },
    );
    await vi.runAllTimersAsync();
    await p2;
    expect(triggerOnStartSearch).toBeCalledWith(200000, record.position);
  });

  it("stopAndWait should reject on server error", async () => {
    const player = new LanPlayer("research_main", "test-engine", "Test Engine");
    await launchPlayer(player);

    // Override sendCommand mock to NOT send bestmove automatically
    (LanEngine.prototype.sendCommand as Mock).mockImplementation(() => {
      return Promise.resolve();
    });

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    const p1 = player.startResearch(record.position, usi);
    await vi.runAllTimersAsync();
    await p1;

    const stopPromise = player.stop();
    await vi.advanceTimersByTimeAsync(100);

    // Simulate server error
    sendMsg({ error: "Engine did not respond to stop command" });

    await expect(stopPromise).rejects.toThrow("Engine did not respond to stop command");
  });
});
