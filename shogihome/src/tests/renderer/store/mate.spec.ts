import { Record } from "tsshogi";
import { MateSearchManager } from "@/renderer/store/mate";
import { defaultMateSearchSettings } from "@/common/settings/mate";
import type { MateHandler } from "@/renderer/players/player";

const player = vi.hoisted(() => ({
  construct: vi.fn(),
  launch: vi.fn(),
  readyNewGame: vi.fn(),
  startMateSearch: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@/renderer/store/settings", () => ({
  useAppSettings: () => ({ engineTimeoutSeconds: 10 }),
}));
vi.mock("@/renderer/players/lan_player", () => ({
  LanPlayer: class {
    launch = player.launch;
    readyNewGame = player.readyNewGame;
    startMateSearch = player.startMateSearch;
    close = player.close;
    constructor(...args: unknown[]) {
      player.construct(...args);
    }
  },
}));

describe("LAN mate search manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    player.launch.mockResolvedValue(undefined);
    player.readyNewGame.mockResolvedValue(undefined);
    player.startMateSearch.mockResolvedValue(undefined);
    player.close.mockResolvedValue(undefined);
  });

  it.each([
    ["lan-engine:test", "test"],
    ["lan-engine", "mate"],
  ])("starts %s through LAN and closes after its result", async (uri, id) => {
    const onNoMate = vi.fn();
    const manager = new MateSearchManager().on("noMate", onNoMate);
    const record = new Record();
    await manager.start(
      {
        ...defaultMateSearchSettings(),
        usi: { uri, name: "Mate" },
        enableMaxSeconds: true,
        maxSeconds: 5,
      },
      record,
    );
    expect(player.construct).toHaveBeenCalledWith(
      "mate_search",
      id,
      "Mate",
      10,
      undefined,
      expect.any(Function),
      undefined,
    );
    expect(player.startMateSearch).toHaveBeenCalledWith(
      record.position,
      record.usi,
      5,
      expect.any(Object),
    );
    const handler = player.startMateSearch.mock.calls[0][3] as MateHandler;
    handler.onNoMate();
    expect(onNoMate).toHaveBeenCalledOnce();
    expect(player.close).toHaveBeenCalledOnce();
  });

  it("rejects local engine references without constructing a player", async () => {
    await expect(
      new MateSearchManager().start(
        { ...defaultMateSearchSettings(), usi: { uri: "es://usi-engine/test", name: "Local" } },
        new Record(),
      ),
    ).rejects.toThrow();
    expect(player.construct).not.toHaveBeenCalled();
  });
});
