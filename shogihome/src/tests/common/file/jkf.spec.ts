import * as shogi from "tsshogi";
import {
  importJKFSafely,
  MAX_JKF_BYTES,
  MAX_JKF_DEPTH,
  MAX_JKF_FORKS,
  MAX_JKF_NODES,
  MAX_JKF_PLY,
} from "@/common/file/jkf";
import { importRecordFromBuffer, RecordFileFormat } from "@/common/file/record";
import { t } from "@/common/i18n";

vi.mock("tsshogi", async (importOriginal) => {
  const original = await importOriginal<typeof shogi>();
  return { ...original, importJKF: vi.fn(original.importJKF) };
});

describe("bounded JKF import", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("preserves normalized moves, comments, forks, and metadata", () => {
    const input = {
      header: { 先手: "A", 後手: "B" },
      initial: { preset: "HIRATE" },
      moves: [
        { comments: ["root"] },
        {
          move: { color: 0, piece: "FU", from: { x: 7, y: 7 }, to: { x: 7, y: 6 } },
          comments: ["main"],
          forks: [[{ move: { color: 0, piece: "FU", from: { x: 2, y: 7 }, to: { x: 2, y: 6 } } }]],
        },
      ],
    };
    const record = importJKFSafely(JSON.stringify(input));
    expect(record).toBeInstanceOf(shogi.Record);
    const expected = shogi.importJKF(input as shogi.JKF) as shogi.Record;
    expect(shogi.exportJKF(record as shogi.Record)).toEqual(shogi.exportJKF(expected));
    expect((record as shogi.Record).first.comment).toBe("root");
    expect(importJKFSafely(shogi.exportJKFString(record as shogi.Record))).toBeInstanceOf(
      shogi.Record,
    );
  });

  it.each([
    null,
    { header: {}, moves: null },
    { header: [], moves: [] },
    { header: { event: {} }, moves: [] },
    { header: {}, moves: { length: 1_000_000_000 } },
    { header: {}, moves: [null] },
    { header: {}, moves: [{ move: [] }] },
    { header: {}, moves: [{ comments: [1] }] },
    { header: {}, moves: [{ comments: { length: 1_000_000_000 } }] },
    { header: {}, moves: [{ forks: { length: 1_000_000_000 } }] },
    { header: {}, moves: [{ forks: ["not an array"] }] },
    { header: {}, moves: [{ forks: [[null]] }] },
  ])("rejects malformed containers before calling the shogi parser: %j", (input) => {
    const parse = vi.mocked(shogi.importJKF);
    expect(importJKFSafely(JSON.stringify(input))).toEqual(new Error(t.invalidJKFStructure));
    expect(parse).not.toHaveBeenCalled();
  });

  it("rejects the 55-byte array-like forks exploit through the shared file importer", () => {
    const parse = vi.mocked(shogi.importJKF);
    const data = new TextEncoder().encode(
      '{"header":{},"moves":[{"forks":{"length":1000000000}}]}',
    );
    expect(data.byteLength).toBe(55);
    expect(importRecordFromBuffer(data, RecordFileFormat.JKF)).toEqual(
      new Error(t.invalidJKFStructure),
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it("limits total move entries across all branches and counts empty forks", () => {
    const parse = vi.mocked(shogi.importJKF);
    for (const moves of [
      Array.from({ length: MAX_JKF_NODES + 1 }, () => ({})),
      [{ forks: [Array.from({ length: MAX_JKF_NODES }, () => ({}))] }],
      [{ forks: Array.from({ length: MAX_JKF_FORKS + 1 }, () => []) }],
      Array.from({ length: MAX_JKF_PLY + 1 }, () => ({ special: "TORYO" })),
    ]) {
      expect(importJKFSafely(JSON.stringify({ header: {}, moves }))).toEqual(
        new Error(t.jkfImportLimit),
      );
    }
    expect(parse).not.toHaveBeenCalled();
  });

  it("checks nesting iteratively before parsing any moves", () => {
    const parse = vi.mocked(shogi.importJKF);
    let moves: unknown[] = [];
    for (let index = 0; index <= MAX_JKF_DEPTH; index++) moves = [{ forks: [moves] }];
    expect(importJKFSafely(JSON.stringify({ header: {}, moves }))).toEqual(
      new Error(t.jkfImportLimit),
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it("accepts nullable optional containers and exact traversal limits", () => {
    expect(
      importJKFSafely(
        JSON.stringify({ header: {}, moves: [{ forks: null, comments: null, move: null }] }),
      ),
    ).toBeInstanceOf(shogi.Record);
    expect(
      importJKFSafely(
        JSON.stringify({ header: {}, moves: Array.from({ length: MAX_JKF_NODES }, () => ({})) }),
      ),
    ).toBeInstanceOf(shogi.Record);
  });

  it("rejects invalid JSON and oversized strings or byte buffers", () => {
    expect(importJKFSafely("{")).toEqual(new Error(t.invalidJKFStructure));
    expect(importJKFSafely(" ".repeat(MAX_JKF_BYTES + 1))).toEqual(new Error(t.jkfImportLimit));
    expect(importJKFSafely("あ".repeat(Math.ceil(MAX_JKF_BYTES / 3)))).toEqual(
      new Error(t.jkfImportLimit),
    );
    expect(importRecordFromBuffer(new Uint8Array(MAX_JKF_BYTES + 1), RecordFileFormat.JKF)).toEqual(
      new Error(t.jkfImportLimit),
    );
  });
});
