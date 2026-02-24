import { LanPlayer } from "@/renderer/players/lan_player";
import { LanEngine } from "@/renderer/network/lan_engine";
import { Record } from "tsshogi";
import { TimeStates } from "@/common/game/time";
import { SearchHandler } from "@/renderer/players/player";
import { Mock } from "vitest";

vi.mock("@/renderer/network/lan_engine");
vi.mock("@/renderer/players/usi.js");

describe("LanPlayer Time Control", () => {
  let player: LanPlayer;
  let messageHandler: (message: string) => void;
  let messageListeners: ((message: string) => boolean)[] = [];

  beforeEach(async () => {
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
      // Deliver message in next tick to let the launch() call start its await
      process.nextTick(() => {
        if (messageHandler) {
          messageHandler(readyMsg);
        }
        messageListeners = messageListeners.filter((l) => !l(readyMsg));
      });
    });

    (LanEngine.prototype.sendCommand as Mock).mockResolvedValue(undefined);
    (LanEngine.prototype.setOption as Mock).mockResolvedValue(undefined);

    player = new LanPlayer("test-session", "test-engine", "Test Engine");

    const launchPromise = player.launch();
    await vi.runAllTimersAsync();
    await launchPromise;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const dummyHandler: SearchHandler = {
    onMove: vi.fn(),
    onResign: vi.fn(),
    onWin: vi.fn(),
    onError: vi.fn(),
  };

  it("should send correct go command for Fischer rule (Black)", async () => {
    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;

    const timeStates: TimeStates = {
      black: { timeMs: 60000, byoyomi: 0, increment: 5 }, // 5s increment
      white: { timeMs: 60000, byoyomi: 0, increment: 5 },
    };

    await player.startSearch(record.position, usi, timeStates, dummyHandler);

    const expectedGo = "go btime 55000 wtime 55000 binc 5000 winc 5000";
    expect(LanEngine.prototype.sendCommand).toHaveBeenCalledWith(expectedGo);
  });

  it("should send correct go command for Byoyomi rule (Black)", async () => {
    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;

    const timeStates: TimeStates = {
      black: { timeMs: 60000, byoyomi: 10, increment: 0 }, // 10s byoyomi
      white: { timeMs: 60000, byoyomi: 10, increment: 0 },
    };

    await player.startSearch(record.position, usi, timeStates, dummyHandler);

    const expectedGo = "go btime 60000 wtime 60000 byoyomi 10000";
    expect(LanEngine.prototype.sendCommand).toHaveBeenCalledWith(expectedGo);
  });

  it("should send correct go command for Fischer rule (White)", async () => {
    const usi = "position startpos moves 7g7f";
    const record = Record.newByUSI(usi) as Record;

    const timeStates: TimeStates = {
      black: { timeMs: 55000, byoyomi: 0, increment: 5 },
      white: { timeMs: 60000, byoyomi: 0, increment: 5 }, // 5s increment
    };

    await player.startSearch(record.position, usi, timeStates, dummyHandler);

    const expectedGo = "go btime 50000 wtime 55000 binc 5000 winc 5000";
    expect(LanEngine.prototype.sendCommand).toHaveBeenCalledWith(expectedGo);
  });

  it("should prioritize Byoyomi over Increment if Byoyomi > 0", async () => {
    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;

    const timeStates: TimeStates = {
      black: { timeMs: 60000, byoyomi: 10, increment: 5 },
      white: { timeMs: 60000, byoyomi: 10, increment: 5 },
    };

    await player.startSearch(record.position, usi, timeStates, dummyHandler);

    const expectedGo = "go btime 55000 wtime 55000 byoyomi 10000";
    expect(LanEngine.prototype.sendCommand).toHaveBeenCalledWith(expectedGo);
  });

  it("should calculate correct time for 3rd move (Black) with Fischer rule", async () => {
    const usi = "position startpos moves 7g7f 3c3d";
    const record = Record.newByUSI(usi) as Record;

    const timeStates: TimeStates = {
      black: { timeMs: 55000, byoyomi: 0, increment: 5 },
      white: { timeMs: 60000, byoyomi: 0, increment: 5 },
    };

    await player.startSearch(record.position, usi, timeStates, dummyHandler);

    const expectedGo = "go btime 50000 wtime 55000 binc 5000 winc 5000";
    expect(LanEngine.prototype.sendCommand).toHaveBeenCalledWith(expectedGo);
  });

  it("should pass delay to handler", async () => {
    const usi = "position startpos";
    const record = Record.newByUSI(usi) as Record;
    const dummyHandler: SearchHandler = {
      onMove: vi.fn(),
      onResign: vi.fn(),
      onWin: vi.fn(),
      onError: vi.fn(),
    };

    const timeStates: TimeStates = {
      black: { timeMs: 60000, byoyomi: 0, increment: 0 },
      white: { timeMs: 60000, byoyomi: 0, increment: 0 },
    };

    await player.startSearch(record.position, usi, timeStates, dummyHandler);

    const response = JSON.stringify({
      sfen: usi,
      info: "bestmove 7g7f",
      delay: 1234,
    });
    messageHandler(response);

    expect(dummyHandler.onMove).toHaveBeenCalledWith(
      expect.objectContaining({ usi: "7g7f" }),
      expect.objectContaining({ delay: 1234, usi }),
    );
  });
});
