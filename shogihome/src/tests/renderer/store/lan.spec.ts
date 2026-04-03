import { beforeEach, describe, expect, it, vi } from "vitest";

const lanDiscoveryEngineMock = vi.hoisted(() => ({
  isConnected: vi.fn(),
  connect: vi.fn(),
  getEngineList: vi.fn(),
  disconnect: vi.fn(),
  subscribeStatus: vi.fn(),
  isIdle: true,
}));

vi.mock("@/renderer/network/lan_engine", () => ({
  lanDiscoveryEngine: lanDiscoveryEngineMock,
}));

describe("store/lan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lanDiscoveryEngineMock.subscribeStatus.mockImplementation(() => () => {
      /* noop */
    });
  });

  it("should disconnect the shared discovery engine after fetch", async () => {
    vi.resetModules();
    lanDiscoveryEngineMock.isConnected.mockReturnValue(false);
    lanDiscoveryEngineMock.connect.mockResolvedValue(undefined);
    lanDiscoveryEngineMock.getEngineList.mockResolvedValue([{ id: "e1", name: "Engine 1" }]);

    const { useLanStore } = await import("@/renderer/store/lan.js");
    const store = useLanStore();
    await store.fetchEngineList();

    expect(lanDiscoveryEngineMock.getEngineList).toBeCalledWith(false);
    expect(lanDiscoveryEngineMock.disconnect).toBeCalledTimes(1);
  });
});
