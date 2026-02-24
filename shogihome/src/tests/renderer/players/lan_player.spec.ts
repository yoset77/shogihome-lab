import { LanPlayer } from "@/renderer/players/lan_player";
import { LanEngine } from "@/renderer/network/lan_engine";
import { dispatchUSIInfoUpdate } from "@/renderer/players/usi.js";
import { Record } from "tsshogi";
import { Mock } from "vitest";

vi.mock("@/renderer/network/lan_engine");
vi.mock("@/renderer/players/usi.js");

describe("LanPlayer", () => {
  let messageHandler: (message: string) => void;
  let messageListeners: ((message: string) => boolean)[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    messageListeners = [];

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

    // Mock startEngine to trigger the ready sequence
    (LanEngine.prototype.startEngine as Mock).mockImplementation(() => {
      const readyMsg = JSON.stringify({ info: "info: engine is ready" });
      // In real LanEngine, ws.onmessage triggers both the handler and the listeners.
      // We simulate this by calling them in the next microtask to let the caller setup if needed.
      process.nextTick(() => {
        if (messageHandler) {
          messageHandler(readyMsg);
        }
        messageListeners = messageListeners.filter((l) => !l(readyMsg));
      });
    });

    (LanEngine.prototype.sendCommand as Mock).mockResolvedValue(undefined);
    (LanEngine.prototype.setOption as Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updateInfo should filter multipv > 1 and use throttling", async () => {
    const onSearchInfo = vi.fn();
    const player = new LanPlayer("test-session", "test-engine", "Test Engine", onSearchInfo);

    const launchPromise = player.launch();
    await vi.runAllTimersAsync();
    await launchPromise;

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

    const launchPromise = player.launch();
    await vi.runAllTimersAsync();
    await launchPromise;

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
    messageHandler(
      JSON.stringify({
        info: "bestmove 7g7f",
      }),
    );
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

    const launchPromise = player.launch();
    await vi.runAllTimersAsync();
    await launchPromise;

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
    messageHandler(
      JSON.stringify({
        sfen: usi1, // Server still tags it with old SFEN
        info: "bestmove 7g7f",
      }),
    );
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

    const launchPromise = player.launch();
    await vi.runAllTimersAsync();
    await launchPromise;

    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    await player.startResearch(record.position, usi);

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
});
