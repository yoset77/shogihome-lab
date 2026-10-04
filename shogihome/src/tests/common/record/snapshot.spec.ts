import { Record, Move, RecordMetadataKey, SpecialMoveType } from "tsshogi";
import {
  decodeRecordSnapshot,
  recordContent,
  restoreRecord,
  snapshotRecord,
  type RecordSnapshot,
} from "@/common/record/snapshot";

function fixture() {
  const record = Record.newByUSI("position startpos moves 7g7f 3c3d 2g2f resign") as Record;
  record.goto(1);
  const move = record.position.createMoveByUSI("8c8d")!;
  record.append(move);
  record.current.comment = "Branch";
  record.current.bookmark = "Example";
  record.current.setElapsedMs(1234);
  record.current.customData = { researchInfo: { score: 0, lowerBound: false, pv: [move] } };
  record.append(SpecialMoveType.INTERRUPT);
  record.goto(1);
  record.metadata.setStandardMetadata(RecordMetadataKey.BLACK_NAME, "Black");
  record.metadata.setCustomMetadata("Source", "original");
  return record;
}

describe("record snapshots", () => {
  it("round trips branches, selection, annotations, clocks, metadata, and PV move objects", () => {
    const source = snapshotRecord(fixture());
    const decoded = decodeRecordSnapshot(JSON.parse(JSON.stringify(source)));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error);
    const { record } = restoreRecord(decoded.value);
    expect(snapshotRecord(record)).toEqual(source);
    record.goto(2);
    expect(record.current.customData).toMatchObject({ researchInfo: { score: 0 } });
    const info = record.current.customData as { researchInfo: { pv: Move[] } };
    expect(info.researchInfo.pv[0]).toBeInstanceOf(Move);
    expect(info.researchInfo.pv[0].usi).toBe("8c8d");
  });

  it("ignores navigation when checking document content", () => {
    const record = fixture();
    const original = recordContent(snapshotRecord(record));
    record.goto(2);
    record.switchBranchByIndex(0);
    expect(recordContent(snapshotRecord(record))).toBe(original);
    record.current.comment = "edited";
    expect(recordContent(snapshotRecord(record))).not.toBe(original);
  });

  it("ignores search info key order after decoding and restoring an unchanged record", () => {
    const record = fixture();
    record.current.customData = {
      researchInfo: { usi: record.usi, score: 0, depth: 20, lowerBound: false },
    };
    const source = snapshotRecord(record);
    const decoded = decodeRecordSnapshot(JSON.parse(JSON.stringify(source)));
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.value).toEqual(JSON.parse(JSON.stringify(source)));
    expect(recordContent(decoded.value)).toBe(recordContent(source));
    expect(recordContent(snapshotRecord(restoreRecord(decoded.value).record))).toBe(
      recordContent(source),
    );
  });

  it("ignores object key order throughout a snapshot without reordering arrays", () => {
    function reverseKeys(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reverseKeys(item)]),
        );
      return value;
    }
    const source = snapshotRecord(fixture());
    expect(recordContent(reverseKeys(source) as RecordSnapshot)).toBe(recordContent(source));
    const reordered = structuredClone(source);
    reordered.nodes.reverse();
    expect(recordContent(reordered)).not.toBe(recordContent(source));
  });

  it.each(["comment", "score", "bound", "metadata", "pv", "branches"])(
    "still detects actual %s changes when comparing content",
    (kind) => {
      const source = snapshotRecord(fixture());
      const edited = structuredClone(source);
      const node = edited.nodes.find((node) => node.customData?.researchInfo)!;
      if (kind === "comment") node.comment += " edited";
      if (kind === "score") node.customData!.researchInfo!.score = 1;
      if (kind === "bound") node.customData!.researchInfo!.lowerBound = true;
      if (kind === "metadata") edited.metadata.custom[0][1] = "edited";
      if (kind === "pv") node.customData!.researchInfo!.pv = [];
      if (kind === "branches") edited.nodes.splice(2, 0, edited.nodes.splice(4, 1)[0]);
      expect(recordContent(edited)).not.toBe(recordContent(source));
    },
  );

  it.each(["duplicate", "cycle", "selection", "move", "pv", "nan", "metadata"])(
    "rejects malformed %s",
    (kind) => {
      const source = snapshotRecord(fixture());
      if (kind === "duplicate") source.nodes[1].id = source.nodes[0].id;
      if (kind === "cycle") source.nodes[1].parentId = source.nodes[1].id;
      if (kind === "selection") source.selectedPath = [source.nodes[0].id];
      if (kind === "move") source.nodes[1].move = "9z9z";
      if (kind === "pv")
        source.nodes[0].customData = { researchInfo: { pv: [{ usi: "bad" } as never] } };
      if (kind === "nan") source.nodes[0].elapsedMs = NaN;
      if (kind === "metadata") source.metadata.custom.push(...source.metadata.custom);
      expect(decodeRecordSnapshot(source).ok).toBe(false);
    },
  );
});
