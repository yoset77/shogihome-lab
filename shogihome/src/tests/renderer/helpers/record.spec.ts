import { RecordFileFormat } from "@/common/file/record";
import { Move, Record, RecordMetadataKey, SpecialMoveType } from "tsshogi";
import {
  detectUnsupportedRecordProperties,
  getRecordDocumentContent,
  getSiblingBranches,
} from "@/renderer/helpers/record";

function buildBranchRecord(): Record {
  const record = new Record();
  const firstMove = record.position.createMoveByUSI("7g7f");
  const secondMove = record.position.createMoveByUSI("3c3d");
  if (!firstMove || !secondMove) {
    throw new Error("Failed to create test moves");
  }
  record.append(firstMove);
  record.append(secondMove);
  record.goto(1);
  const branchMove = record.position.createMoveByUSI("8c8d");
  if (!branchMove) {
    throw new Error("Failed to create test moves");
  }
  record.append(branchMove);
  return record;
}

describe("helpers/record", () => {
  it("compares document content independently of the current position and selected branches", () => {
    const record = buildBranchRecord();
    const content = getRecordDocumentContent(record);
    record.goto(0);
    record.resetAllBranchSelection();
    record.goto(2);
    expect(getRecordDocumentContent(record)).toBe(content);
  });

  it.each(["comment", "bookmark", "time", "standardMetadata", "customMetadata", "branch"])(
    "detects local %s edits",
    (edit) => {
      const record = buildBranchRecord();
      const content = getRecordDocumentContent(record);
      switch (edit) {
        case "comment":
          record.first.comment = "new comment";
          break;
        case "bookmark":
          record.first.bookmark = "new bookmark";
          break;
        case "time":
          record.current.setElapsedMs(1);
          break;
        case "standardMetadata":
          record.metadata.setStandardMetadata(RecordMetadataKey.TITLE, "new title");
          break;
        case "customMetadata":
          record.metadata.setCustomMetadata("custom", "new value");
          break;
        case "branch":
          record.goto(1);
          record.append(record.position.createMoveByUSI("5c5d")!);
          break;
      }
      expect(getRecordDocumentContent(record)).not.toBe(content);
    },
  );

  it("allows fetch-time comparisons to ignore transient search data but checks it before replacement", () => {
    const record = buildBranchRecord();
    const full = getRecordDocumentContent(record);
    const document = getRecordDocumentContent(record, false);
    record.current.customData = { researchInfo: { depth: 10, score: 20 } };
    expect(getRecordDocumentContent(record, false)).toBe(document);
    expect(getRecordDocumentContent(record)).not.toBe(full);
    const updated = getRecordDocumentContent(record);
    record.current.customData = { researchInfo: { score: 20, depth: 10 } };
    expect(getRecordDocumentContent(record)).toBe(updated);
  });

  it("detectUnsupportedRecordProperties", () => {
    const record = new Record();
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.KIF)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: false,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.KIFU)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: false,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.KI2)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: false,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.KI2U)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: false,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.CSA)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: false,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.SFEN)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: false,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.JKF)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: false,
    });

    record.append(SpecialMoveType.RESIGN);
    record.append(SpecialMoveType.INTERRUPT);
    record.first.comment = "foo";
    record.first.bookmark = "bar";
    record.current.setElapsedMs(123);
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.KIF)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: false,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.KIFU)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: false,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.KI2)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: true,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.KI2U)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: false,
      time: true,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.CSA)).toStrictEqual({
      branch: true,
      comment: false,
      bookmark: true,
      time: false,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.SFEN)).toStrictEqual({
      branch: true,
      comment: true,
      bookmark: true,
      time: true,
    });
    expect(detectUnsupportedRecordProperties(record, RecordFileFormat.JKF)).toStrictEqual({
      branch: false,
      comment: false,
      bookmark: true,
      time: false,
    });
  });

  it("getSiblingBranches returns sibling branches", () => {
    const record = buildBranchRecord();
    const mainNode = record.first.next?.next;
    const branchNode = mainNode?.branch;
    if (!mainNode || !branchNode) {
      throw new Error("Failed to build branch record");
    }
    expect((mainNode.move as Move).usi).toBe("3c3d");
    expect((branchNode.move as Move).usi).toBe("8c8d");

    const fromMain = getSiblingBranches(record, mainNode);
    const fromBranch = getSiblingBranches(record, branchNode);
    expect(fromMain?.map((node) => (node.move as Move).usi)).toStrictEqual(["3c3d", "8c8d"]);
    expect(fromBranch?.map((node) => (node.move as Move).usi)).toStrictEqual(["3c3d", "8c8d"]);
  });

  it("getSiblingBranches returns null when there are no branches", () => {
    const record = buildBranchRecord();
    const singleNode = record.first.next;
    if (!singleNode) {
      throw new Error("Failed to build record");
    }
    expect(getSiblingBranches(record, singleNode)).toBeNull();
    expect(getSiblingBranches(record, record.first)).toBeNull();
  });
});
