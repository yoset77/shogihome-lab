import type { USIInfoCommand } from "@/common/game/usi";
import { mergeAnalysisInfo, selectAnalysisInfosForSave } from "@/server/engine/analysis_info";

describe("analysis info accumulation", () => {
  it("preserves omitted fields without mutating either update", () => {
    const current = Object.freeze({
      depth: 10,
      nodes: 100,
      timeMs: 1000,
      scoreCP: 20,
      lowerbound: true,
      pv: ["7g7f"],
    });
    const incoming = Object.freeze({ depth: 11, seldepth: 15 });

    expect(mergeAnalysisInfo(current, incoming)).toEqual({
      ...current,
      depth: 11,
      seldepth: 15,
    });
    expect(current.depth).toBe(10);
    expect(incoming).toEqual({ depth: 11, seldepth: 15 });
  });

  it.each<USIInfoCommand>([
    { depth: 11, scoreCP: 0 },
    { depth: 11, scoreMate: 5 },
    { depth: 11, scoreMate: -5, upperbound: true },
  ])("replaces the score kind and bound atomically: %j", (incoming) => {
    const current = Object.freeze({ depth: 10, scoreCP: 100, lowerbound: true });
    const next = mergeAnalysisInfo(current, incoming)!;

    expect(next.scoreCP).toBe(incoming.scoreCP);
    expect(next.scoreMate).toBe(incoming.scoreMate);
    expect(next.lowerbound).toBe(incoming.lowerbound);
    expect(next.upperbound).toBe(incoming.upperbound);
    expect(current).toEqual({ depth: 10, scoreCP: 100, lowerbound: true });
  });

  it("clears a mate score when a centipawn score arrives", () => {
    const next = mergeAnalysisInfo(
      { depth: 10, scoreMate: 5, upperbound: true },
      { depth: 11, scoreCP: 30, lowerbound: true },
    )!;

    expect(next.scoreCP).toBe(30);
    expect(next.scoreMate).toBeUndefined();
    expect(next.lowerbound).toBe(true);
    expect(next.upperbound).toBeUndefined();
  });

  it("creates an initial entry without previous info", () => {
    const incoming = Object.freeze({ depth: 0, nodes: 100 });
    const next = mergeAnalysisInfo(undefined, incoming);
    expect(next).toEqual(incoming);
    expect(next).not.toBe(incoming);
  });

  it.each<USIInfoCommand>([
    { nodes: 200, timeMs: 2000 },
    { scoreCP: 30, pv: ["2g2f"] },
    { depth: 11, scoreCP: 30, lowerbound: true, upperbound: true },
    { depth: 11, lowerbound: true },
    { depth: 11, upperbound: true },
  ])("does not accumulate depth-less updates or invalid bounds: %j", (incoming) => {
    const current = Object.freeze({ depth: 10, scoreCP: 20 });
    expect(mergeAnalysisInfo(current, incoming)).toBeNull();
    expect(current).toEqual({ depth: 10, scoreCP: 20 });
  });
});

describe("analysis info selection for persistence", () => {
  it("filters by minimum depth and sorts by MultiPV without changing the input map", () => {
    const infos = new Map<number, USIInfoCommand>([
      [3, { depth: 11, pv: ["2g2f"] }],
      [2, { depth: 9, pv: ["5g5f"] }],
      [1, { depth: 10, pv: ["7g7f"] }],
      [4, { scoreCP: 20, pv: ["1g1f"] }],
    ]);
    const originalEntries = [...infos];

    expect([...selectAnalysisInfosForSave(infos, 10)]).toEqual([
      [1, infos.get(1)],
      [3, infos.get(3)],
    ]);
    expect([...infos]).toEqual(originalEntries);
  });

  it("prefers the lowest MultiPV rank for duplicate first moves regardless of depth", () => {
    const infos = new Map<number, USIInfoCommand>([
      [2, { depth: 20, pv: ["7g7f", "8c8d"] }],
      [1, { depth: 10, pv: ["7g7f", "3c3d"] }],
    ]);
    expect([...selectAnalysisInfosForSave(infos, 10)]).toEqual([[1, infos.get(1)]]);
  });

  it("does not let an excluded entry suppress an eligible duplicate", () => {
    const infos = new Map<number, USIInfoCommand>([
      [1, { depth: 9, pv: ["7g7f"] }],
      [2, { depth: 10, pv: ["7g7f"] }],
    ]);
    expect([...selectAnalysisInfosForSave(infos, 10)]).toEqual([[2, infos.get(2)]]);
  });

  it("keeps entries without a first move distinct", () => {
    const infos = new Map<number, USIInfoCommand>([
      [1, { depth: 10 }],
      [2, { depth: 10, pv: [] }],
    ]);
    expect([...selectAnalysisInfosForSave(infos, 10)]).toEqual([...infos]);
  });

  it("accepts depth zero when the minimum is zero", () => {
    const infos = new Map<number, USIInfoCommand>([[1, { depth: 0 }]]);
    expect([...selectAnalysisInfosForSave(infos, 0)]).toEqual([...infos]);
  });

  it("returns an empty map when no entry is eligible", () => {
    expect(selectAnalysisInfosForSave(new Map(), 10).size).toBe(0);
    expect(selectAnalysisInfosForSave(new Map([[1, { depth: 9 }]]), 10).size).toBe(0);
  });
});
