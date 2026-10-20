import { Record } from "tsshogi";
import { ResearchManager } from "@/renderer/store/research";
import { defaultResearchSettings, type ResearchSettings } from "@/common/settings/research";
import { SearchInfoSenderType } from "@/renderer/store/record";
import type { SearchInfo } from "@/renderer/players/player";

const players = vi.hoisted(
  () =>
    [] as {
      key: string;
      engineId: string;
      name: string;
      sessionID: number;
      multiPV: number;
      launch: ReturnType<typeof vi.fn>;
      readyNewGame: ReturnType<typeof vi.fn>;
      startResearch: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      setMultiPV: ReturnType<typeof vi.fn>;
      onInfo: (info: SearchInfo) => void;
    }[],
);

vi.mock("@/renderer/store/settings", () => ({
  useAppSettings: () => ({ engineTimeoutSeconds: 10 }),
}));
vi.mock("@/renderer/players/lan_player", () => ({
  LanPlayer: class {
    sessionID = 200000 + players.length;
    multiPV = 1;
    launch = vi.fn().mockResolvedValue(undefined);
    readyNewGame = vi.fn().mockResolvedValue(undefined);
    startResearch = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    setMultiPV = vi.fn(async (value: number) => {
      this.multiPV = value;
    });
    constructor(
      public key: string,
      public engineId: string,
      public name: string,
      _timeout: number,
      public onInfo: (info: SearchInfo) => void,
    ) {
      players.push(this);
    }
  },
}));

const settings = (overrides: Partial<ResearchSettings> = {}): ResearchSettings => ({
  ...defaultResearchSettings(),
  usi: { uri: "lan-engine:main", name: "Main" },
  ...overrides,
});

describe("LAN research manager", () => {
  const managers: ResearchManager[] = [];
  const manager = () => {
    const result = new ResearchManager();
    managers.push(result);
    return result;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    players.length = 0;
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((value) => value.close()));
    vi.useRealTimers();
  });

  it("launches a LAN engine and coalesces position updates", async () => {
    const research = manager();
    await research.launch(settings());
    expect(players[0]).toMatchObject({ key: "research_main", engineId: "main", name: "Main" });
    expect(players[0].launch).toHaveBeenCalledOnce();
    expect(players[0].readyNewGame).toHaveBeenCalledOnce();
    const record = new Record();
    research.updatePosition(record);
    record.append(record.position.createMoveByUSI("7g7f")!);
    research.updatePosition(record);
    await vi.advanceTimersByTimeAsync(200);
    expect(players[0].startResearch).toHaveBeenCalledExactlyOnceWith(record.position, record.usi);
    await vi.advanceTimersByTimeAsync(5000);
    expect(players[0].stop).not.toHaveBeenCalled();
  });

  it("stops each search at its configured deadline", async () => {
    const research = manager();
    await research.launch(settings({ enableMaxSeconds: true, maxSeconds: 5 }));
    research.updatePosition(new Record());
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(4999);
    expect(players[0].stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(players[0].stop).toHaveBeenCalledOnce();
  });

  it("runs secondary engines with separate session keys and info slots", async () => {
    const onInfo = vi.fn();
    const research = manager().on("updateSearchInfo", onInfo);
    await research.launch(
      settings({
        secondaries: [
          { usi: { uri: "lan-engine:second", name: "Second" } },
          { usi: { uri: "lan-engine:third", name: "Third" } },
        ],
      }),
    );
    expect(players.map((player) => player.key)).toEqual([
      "research_main",
      "research_sub_1",
      "research_sub_2",
    ]);
    research.updatePosition(new Record());
    await vi.advanceTimersByTimeAsync(200);
    const info = { depth: 10 } as SearchInfo;
    players.forEach((player) => {
      expect(player.startResearch).toHaveBeenCalledOnce();
      player.onInfo(info);
    });
    expect(onInfo.mock.calls.map(([slot]) => slot)).toEqual([
      SearchInfoSenderType.RESEARCHER,
      SearchInfoSenderType.RESEARCHER_2,
      SearchInfoSenderType.RESEARCHER_3,
    ]);
  });

  it("pauses individual sessions and resumes from the latest position", async () => {
    const research = manager();
    await research.launch(
      settings({ secondaries: [{ usi: { uri: "lan-engine:second", name: "Second" } }] }),
    );
    const record = new Record();
    research.updatePosition(record);
    await vi.advanceTimersByTimeAsync(200);
    research.pause(players[1].sessionID);
    expect(research.isPaused(players[1].sessionID)).toBe(true);
    record.append(record.position.createMoveByUSI("7g7f")!);
    research.updatePosition(record);
    await vi.advanceTimersByTimeAsync(200);
    expect(players[0].startResearch).toHaveBeenCalledTimes(2);
    expect(players[1].startResearch).toHaveBeenCalledOnce();
    research.unpause(players[1].sessionID);
    expect(research.isPaused(players[1].sessionID)).toBe(false);
    expect(players[1].startResearch).toHaveBeenLastCalledWith(record.position, record.usi);
    research.pause();
    expect(players.every((player) => research.isPaused(player.sessionID))).toBe(true);
    research.unpause();
    expect(players.every((player) => !research.isPaused(player.sessionID))).toBe(true);
  });

  it("overrides MultiPV only when requested and stops before changing it", async () => {
    const research = manager();
    await research.launch(settings({ overrideMultiPV: true, multiPV: 4 }));
    expect(players[0].setMultiPV).toHaveBeenCalledExactlyOnceWith(4);
    research.updatePosition(new Record());
    await vi.advanceTimersByTimeAsync(200);
    research.setMultiPV(players[0].sessionID, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(research.getMultiPV(players[0].sessionID)).toBe(2);
    expect(players[0].stop.mock.invocationCallOrder[0]).toBeLessThan(
      players[0].setMultiPV.mock.invocationCallOrder[1],
    );
    expect(players[0].startResearch).toHaveBeenCalledTimes(2);
    const inherited = manager();
    await inherited.launch(settings());
    expect(players[1].setMultiPV).not.toHaveBeenCalled();
  });

  it("prevents restarts while closing and waits before the next launch", async () => {
    const research = manager();
    await research.launch(settings());
    let finishClose!: () => void;
    players[0].close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    research.updatePosition(new Record());
    const closing = research.close();
    research.updatePosition(new Record());
    const launching = research.launch(settings());
    await vi.advanceTimersByTimeAsync(200);
    expect(players).toHaveLength(1);
    expect(players[0].startResearch).not.toHaveBeenCalled();
    finishClose();
    await closing;
    await launching;
    expect(players).toHaveLength(2);
  });

  it("retains the legacy LAN engine alias", async () => {
    await manager().launch(settings({ usi: { uri: "lan-engine", name: "Legacy" } }));
    expect(players[0].engineId).toBe("research");
  });

  it("rejects non-LAN references before creating a player", async () => {
    await expect(
      manager().launch(settings({ usi: { uri: "es://usi-engine/test", name: "Local" } })),
    ).rejects.toThrow();
    expect(players).toHaveLength(0);
  });
});
