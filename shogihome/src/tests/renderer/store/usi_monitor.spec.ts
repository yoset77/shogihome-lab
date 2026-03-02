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
});
