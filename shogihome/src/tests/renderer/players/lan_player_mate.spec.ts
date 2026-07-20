import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { LanPlayer } from "@/renderer/players/lan_player";
import { LanEngine } from "@/renderer/network/lan_engine";
import { Position } from "tsshogi";
import { triggerOnStartSearch, dispatchUSIInfoUpdate } from "@/renderer/players/usi_events";
import type { ServerRelayMessage } from "@/common/engine/relay_protocol";

vi.mock("@/renderer/network/lan_engine");
vi.mock("@/renderer/ipc/api");
vi.mock("@/renderer/players/usi_events");

describe("LanPlayer Mate Search", () => {
  let mockLanEngine: {
    connect: Mock;
    disconnect: Mock;
    startEngine: Mock;
    stopEngine: Mock;
    sendUsiCommand: Mock;
    addMessageListener: Mock;
    removeMessageListener: Mock;
    subscribeStatus: Mock;
    isConnected: Mock;
    setMultiPV: Mock;
  };
  let messageHandler: (msg: ServerRelayMessage) => void;
  let messageListeners: ((msg: ServerRelayMessage) => boolean)[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    messageListeners = [];
    mockLanEngine = {
      connect: vi.fn().mockImplementation(async (handler) => {
        messageHandler = handler;
      }),
      disconnect: vi.fn(),
      startEngine: vi.fn(),
      stopEngine: vi.fn(),
      sendUsiCommand: vi.fn(),
      addMessageListener: vi.fn().mockImplementation((l) => messageListeners.push(l)),
      removeMessageListener: vi.fn().mockImplementation((l) => {
        messageListeners = messageListeners.filter((i) => i !== l);
      }),
      subscribeStatus: vi.fn().mockReturnValue(() => {}),
      isConnected: vi.fn().mockReturnValue(true),
      setMultiPV: vi.fn(),
    };
    (LanEngine as Mock).mockImplementation(function () {
      return mockLanEngine;
    });
  });

  function sendMsg(msg: ServerRelayMessage) {
    if (messageHandler) {
      messageHandler(msg);
    }
    messageListeners.forEach((listener) => listener(msg));
  }

  async function launchPlayer(
    player: LanPlayer,
    msg: ServerRelayMessage = {
      type: "state",
      state: "ready",
      engineId: (player as unknown as { engineId: string }).engineId,
    },
  ) {
    const launchPromise = player.launch();
    await vi.advanceTimersByTimeAsync(100);
    sendMsg(msg);
    await launchPromise;
  }

  it("should send go mate and handle checkmate moves", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    await launchPlayer(player);

    const pos = new Position();
    const handler = {
      onCheckmate: vi.fn(),
      onNoMate: vi.fn(),
      onTimeout: vi.fn(),
      onNotImplemented: vi.fn(),
      onError: vi.fn(),
    };

    await player.startMateSearch(pos, "position startpos", 10, handler);

    expect(mockLanEngine.sendUsiCommand).toHaveBeenCalledWith("position startpos");
    expect(mockLanEngine.sendUsiCommand).toHaveBeenCalledWith("go mate 10000");
    expect(triggerOnStartSearch).toHaveBeenCalled();

    // Simulate engine response
    sendMsg({
      type: "engineOutput",
      positionCommand: "position startpos",
      output: "checkmate 7g7f 3c3d",
    });

    expect(handler.onCheckmate).toHaveBeenCalled();
    const moves = handler.onCheckmate.mock.calls[0][0];
    expect(moves).toHaveLength(2);
    expect(moves[0].usi).toBe("7g7f");
    expect(moves[1].usi).toBe("3c3d");
    expect(dispatchUSIInfoUpdate).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Position),
      "Test Engine",
      { pv: ["7g7f", "3c3d"] },
    );
  });

  it("should call dispatchUSIInfoUpdate for info messages even if onSearchInfo is undefined", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    await launchPlayer(player);

    const pos = new Position();
    const handler = {
      onCheckmate: vi.fn(),
      onNoMate: vi.fn(),
      onTimeout: vi.fn(),
      onNotImplemented: vi.fn(),
      onError: vi.fn(),
    };

    await player.startMateSearch(pos, "position startpos", 10, handler);

    sendMsg({
      type: "engineOutput",
      positionCommand: "position startpos",
      output: "info depth 10 nodes 1000 score mate +5 pv 7g7f 3c3d",
    });

    expect(dispatchUSIInfoUpdate).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Position),
      "Test Engine",
      expect.objectContaining({
        depth: 10,
        nodes: 1000,
        scoreMate: 5,
        pv: ["7g7f", "3c3d"],
      }),
    );
  });

  it("should handle checkmate nomate", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    await launchPlayer(player);

    const pos = new Position();
    const handler = {
      onCheckmate: vi.fn(),
      onNoMate: vi.fn(),
      onTimeout: vi.fn(),
      onNotImplemented: vi.fn(),
      onError: vi.fn(),
    };

    await player.startMateSearch(pos, "position startpos", undefined, handler);
    expect(mockLanEngine.sendUsiCommand).toHaveBeenCalledWith("go mate infinite");

    sendMsg({
      type: "engineOutput",
      positionCommand: "position startpos",
      output: "checkmate nomate",
    });

    expect(handler.onNoMate).toHaveBeenCalled();
  });

  it("should handle checkmate timeout", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    await launchPlayer(player);

    const pos = new Position();
    const handler = {
      onCheckmate: vi.fn(),
      onNoMate: vi.fn(),
      onTimeout: vi.fn(),
      onNotImplemented: vi.fn(),
      onError: vi.fn(),
    };

    await player.startMateSearch(pos, "position startpos", 5, handler);

    sendMsg({
      type: "engineOutput",
      positionCommand: "position startpos",
      output: "checkmate timeout",
    });

    expect(handler.onTimeout).toHaveBeenCalled();
  });

  it("should handle checkmate notimplemented", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    await launchPlayer(player);

    const pos = new Position();
    const handler = {
      onCheckmate: vi.fn(),
      onNoMate: vi.fn(),
      onTimeout: vi.fn(),
      onNotImplemented: vi.fn(),
      onError: vi.fn(),
    };

    await player.startMateSearch(pos, "position startpos", undefined, handler);

    sendMsg({
      type: "engineOutput",
      positionCommand: "position startpos",
      output: "checkmate notimplemented",
    });

    expect(handler.onNotImplemented).toHaveBeenCalled();
  });

  it("should handle error in move parsing", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    await launchPlayer(player);

    const pos = new Position();
    const handler = {
      onCheckmate: vi.fn(),
      onNoMate: vi.fn(),
      onTimeout: vi.fn(),
      onNotImplemented: vi.fn(),
      onError: vi.fn(),
    };

    await player.startMateSearch(pos, "position startpos", undefined, handler);

    sendMsg({
      type: "engineOutput",
      positionCommand: "position startpos",
      output: "checkmate invalidmove",
    });

    expect(handler.onError).toHaveBeenCalledWith(expect.stringContaining("Invalid move"));
    expect(handler.onCheckmate).not.toHaveBeenCalled();
  });
});
