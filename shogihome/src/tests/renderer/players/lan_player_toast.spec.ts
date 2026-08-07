import { LanPlayer } from "@/renderer/players/lan_player";
import { LanEngine, LanEngineStatus } from "@/renderer/network/lan_engine";
import { useToastStore } from "@/renderer/store/toast";
import type { ServerRelayMessage } from "@/common/engine/relay_protocol";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/renderer/network/lan_engine");
vi.mock("@/renderer/ipc/api");
vi.mock("@/renderer/players/usi_events");

describe("LanPlayer transport toasts", () => {
  let statusListener: ((status: LanEngineStatus) => void) | undefined;
  let messageListeners: ((message: ServerRelayMessage) => boolean)[];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useToastStore().clear();
    statusListener = undefined;
    messageListeners = [];
    (LanEngine.prototype.subscribeStatus as Mock).mockImplementation(
      (listener: (status: LanEngineStatus) => void) => {
        statusListener = listener;
        listener("disconnected");
        return () => undefined;
      },
    );
    (LanEngine.prototype.connect as Mock).mockResolvedValue(undefined);
    (LanEngine.prototype.addMessageListener as Mock).mockImplementation((listener) => {
      messageListeners.push(listener);
    });
    (LanEngine.prototype.removeMessageListener as Mock).mockImplementation((listener) => {
      messageListeners = messageListeners.filter((item) => item !== listener);
    });
  });

  it("does not notify on initial connection, but replaces an interruption with recovery", async () => {
    const player = new LanPlayer("test-session", "test-engine", "Test Engine");
    expect(useToastStore().toasts).toHaveLength(0);

    statusListener?.("connected");
    expect(useToastStore().toasts).toHaveLength(0);

    const launchPromise = player.launch();
    await Promise.resolve();
    const readyMessage: ServerRelayMessage = {
      type: "state",
      state: "ready",
      engineId: "test-engine",
    };
    messageListeners.forEach((listener) => listener(readyMessage));
    await launchPromise;

    statusListener?.("connecting");
    statusListener?.("connected");
    expect(useToastStore().toasts).toHaveLength(0);

    statusListener?.("disconnected");
    expect(useToastStore().toasts).toHaveLength(1);
    expect(useToastStore().toasts[0].type).toBe("warning");

    statusListener?.("connected");
    expect(useToastStore().toasts).toHaveLength(1);
    expect(useToastStore().toasts[0].type).toBe("success");
  });

  it("does not notify when the transport disconnects before launch completes", () => {
    new LanPlayer("test-session", "test-engine", "Test Engine");

    statusListener?.("connected");
    statusListener?.("disconnected");

    expect(useToastStore().toasts).toHaveLength(0);
  });

  it("unsubscribes before disconnecting after a launch timeout", async () => {
    vi.useFakeTimers();
    let subscribed = true;
    let subscribedAtDisconnect: boolean | undefined;
    (LanEngine.prototype.subscribeStatus as Mock).mockImplementation((listener) => {
      statusListener = listener;
      listener("disconnected");
      return () => {
        subscribed = false;
      };
    });
    (LanEngine.prototype.connect as Mock).mockResolvedValue(undefined);
    (LanEngine.prototype.disconnect as Mock).mockImplementation(() => {
      subscribedAtDisconnect = subscribed;
      if (subscribed) statusListener?.("disconnected");
    });

    try {
      const player = new LanPlayer("test-session", "test-engine", "Test Engine", 1);
      statusListener?.("connected");
      const launchPromise = player.launch();
      const expectedLaunchFailure = expect(launchPromise).rejects.toThrow(
        "Timeout: Failed to receive ready message from engine",
      );

      await vi.advanceTimersByTimeAsync(1000);
      await expectedLaunchFailure;

      expect(subscribedAtDisconnect).toBe(false);
      expect(useToastStore().toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
