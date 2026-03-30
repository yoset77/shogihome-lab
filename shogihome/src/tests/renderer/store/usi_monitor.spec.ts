import { USIMonitor } from "@/renderer/store/usi";
import { isActiveUSIPlayerSession } from "@/renderer/players/usi.js";
import { isActiveLanPlayerSession } from "@/renderer/players/lan_player.js";
import { Mock } from "vitest";
import { Color, ImmutablePosition } from "tsshogi";

vi.mock("@/renderer/players/usi.js");
vi.mock("@/renderer/players/lan_player.js");

describe("USIMonitor", () => {
  it("should preserve active sessions and prune inactive ones during dequeue", () => {
    const monitor = new USIMonitor();
    const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
    const position = { sfen, color: Color.BLACK } as unknown as ImmutablePosition;

    // Setup mock status
    // 101: Active Local
    // 102: Inactive Local
    // 200000: Active LAN
    // 200001: Inactive LAN
    (isActiveUSIPlayerSession as Mock).mockImplementation((id) => id === 101);
    (isActiveLanPlayerSession as Mock).mockImplementation((id) => id === 200000);

    vi.useFakeTimers();

    // Initial updates to create sessions
    monitor.update(101, position, "Local Active", { multipv: 1, scoreCP: 100, pv: ["7g7f"] }, 100);
    monitor.update(
      102,
      position,
      "Local Inactive",
      { multipv: 1, scoreCP: 100, pv: ["7g7f"] },
      100,
    );
    monitor.update(200000, position, "LAN Active", { multipv: 1, scoreCP: 100, pv: ["7g7f"] }, 100);
    monitor.update(
      200001,
      position,
      "LAN Inactive",
      { multipv: 1, scoreCP: 100, pv: ["7g7f"] },
      100,
    );

    // Dequeue happens after 500ms and processes the updateQueue.
    // At this point, ALL 4 are in updateQueue, so none are pruned.
    vi.advanceTimersByTime(500);

    // Now sessions are established. Trigger another dequeue WITHOUT updates for 102 and 200001.
    monitor.update(101, position, "Local Active", { multipv: 1, scoreCP: 110, pv: ["7g7f"] }, 100);
    vi.advanceTimersByTime(500);

    const activeMonitors = monitor.sessions;
    const sessionIDs = activeMonitors.map((m) => m.sessionID);

    expect(sessionIDs).toContain(101); // Local Active preserved
    expect(sessionIDs).not.toContain(102); // Local Inactive pruned
    expect(sessionIDs).toContain(200000); // LAN Active preserved
    expect(sessionIDs).not.toContain(200001); // LAN Inactive pruned

    vi.useRealTimers();
  });

  it("should update engine name and clear monitor when engine changes for the same sessionID", () => {
    const monitor = new USIMonitor();
    const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
    const position = { sfen, color: Color.BLACK } as unknown as ImmutablePosition;

    (isActiveLanPlayerSession as Mock).mockReturnValue(true);
    vi.useFakeTimers();

    // 最初は Engine A で起動
    monitor.update(200000, position, "Engine A", { depth: 10, scoreCP: 100, pv: ["7g7f"] }, 100);
    vi.advanceTimersByTime(500);
    expect(monitor.sessions[0].name).toBe("Engine A");
    expect(monitor.sessions[0].infoList).toHaveLength(1);

    // 同じ sessionID で Engine B に切り替え
    monitor.update(200000, position, "Engine B", { depth: 5, scoreCP: -50, pv: ["2g2f"] }, 100);
    vi.advanceTimersByTime(500);

    // 名前が更新され、履歴がクリアされて新しい情報のみになっていること
    expect(monitor.sessions[0].name).toBe("Engine B");
    expect(monitor.sessions[0].infoList).toHaveLength(1);
    expect(monitor.sessions[0].infoList[0].score).toBe(-50);

    vi.useRealTimers();
  });

  it("should only update global stats from multipv 1 or undefined", () => {
    const monitor = new USIMonitor();
    const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
    const position = { sfen, color: Color.BLACK } as unknown as ImmutablePosition;

    (isActiveLanPlayerSession as Mock).mockReturnValue(true);
    vi.useFakeTimers();

    // multipv 1 の更新
    monitor.update(
      200000,
      position,
      "Engine",
      { multipv: 1, nodes: 10000, nps: 20000, hashfullPerMill: 500, currmove: "7g7f" },
      100,
    );
    vi.advanceTimersByTime(500);
    expect(monitor.sessions[0].nodes).toBe(10000);
    expect(monitor.sessions[0].nps).toBe(20000);
    expect(monitor.sessions[0].hashfull).toBe(0.5);
    expect(monitor.sessions[0].currentMove).toBe("7g7f");

    // multipv 2 の更新 (小さなノード数などを送ってきたと想定)
    monitor.update(
      200000,
      position,
      "Engine",
      { multipv: 2, nodes: 3000, nps: 20000, currmove: "2g2f" },
      100,
    );
    vi.advanceTimersByTime(500);
    // 全体の統計は multipv 1 の時のまま維持されていること
    expect(monitor.sessions[0].nodes).toBe(10000);
    expect(monitor.sessions[0].currentMove).toBe("7g7f");
    // ただし、個別行の情報としては 3000 が保持されていること
    expect(monitor.sessions[0].infoList[0].nodes).toBe(3000);

    vi.useRealTimers();
  });

  it("should format PV text with the shared helper", () => {
    const monitor = new USIMonitor();
    const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
    const position = { sfen, color: Color.BLACK } as unknown as ImmutablePosition;

    (isActiveLanPlayerSession as Mock).mockReturnValue(true);
    vi.useFakeTimers();

    monitor.update(
      200000,
      position,
      "Engine",
      { multipv: 1, scoreCP: 100, pv: ["7g7f", "3c3d", "invalidmove"] },
      2,
    );
    vi.advanceTimersByTime(500);

    expect(monitor.sessions[0].infoList[0].text?.endsWith(" ...")).toBe(true);

    vi.useRealTimers();
  });
});
