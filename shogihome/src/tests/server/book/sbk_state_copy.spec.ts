import fs from "node:fs";
import path from "node:path";
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { SBook, SBookState } from "@/server/book/proto/sbk";
import { copySbkStateWithoutHashKeys } from "@/server/book/sbk_state_copy";

function copy(data: Uint8Array): Uint8Array | undefined {
  const reader = new BinaryReader(data);
  reader.uint32();
  const length = reader.uint32();
  return copySbkStateWithoutHashKeys(data, 0, reader.pos, reader.pos + length);
}

function reencode(data: Uint8Array): Uint8Array {
  const reader = new BinaryReader(data);
  reader.uint32();
  const state = SBookState.decode(reader, reader.uint32());
  state.BoardKey = 0n;
  state.HandKey = 0;
  return encode(state);
}

function encode(state: SBookState): Uint8Array {
  return SBookState.encode(state, new BinaryWriter().uint32(26).fork()).join().finish();
}

describe("server/book/sbk_state_copy", () => {
  const fixtureDir = "src/tests/testdata/book";
  const fixtures = fs
    .readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".sbk"))
    .sort();

  it.each(fixtures)("matches re-encoding for every state in %s", (name) => {
    const data = new Uint8Array(fs.readFileSync(path.join(fixtureDir, name)));
    const reader = new BinaryReader(data);
    let stateCount = 0;
    while (reader.pos < reader.len) {
      const tagOffset = reader.pos;
      const [field, wireType] = reader.tag();
      if (field !== 3 || wireType !== 2) {
        reader.skip(wireType, field);
        continue;
      }
      const length = reader.uint32();
      const payloadStart = reader.pos;
      const end = payloadStart + length;
      const copied = copySbkStateWithoutHashKeys(data, tagOffset, payloadStart, end);
      expect(copied, `state ${stateCount} at offset ${tagOffset}`).toEqual(
        reencode(data.subarray(tagOffset, end)),
      );
      reader.pos = end;
      stateCount++;
    }
    expect(stateCount).toBeGreaterThan(0);
    expect(stateCount).toBe(SBook.decode(data).BookStates.length);
  });

  it.each([
    { BoardKey: 0n, HandKey: 0 },
    { BoardKey: (1n << 64n) - 1n, HandKey: 0 },
    { BoardKey: 0n, HandKey: 0xffffffff },
    { BoardKey: (1n << 64n) - 1n, HandKey: 0xffffffff },
  ])("matches re-encoding with hash keys $BoardKey and $HandKey", (hashKeys) => {
    const data = encode(
      SBookState.create({
        ...hashKeys,
        Id: 2147483647,
        Comment: "解析：🀄".repeat(20),
        Games: 42,
        Moves: [{ Move: -2147483648, Evaluation: 1, Weight: 128, NextStateId: -1 }, {}],
        Evals: [
          { EvaluationValue: -120, Nodes: -(1n << 63n), Variation: "7g7f", EngineName: "将棋" },
          { Nodes: (1n << 63n) - 1n },
          {},
        ],
      }),
    );
    const copied = copy(data);
    expect(copied).toEqual(reencode(data));
    if (hashKeys.BoardKey === 0n && hashKeys.HandKey === 0) {
      expect(copied?.buffer).toBe(data.buffer);
    }
  });

  it("can shorten the outer length prefix when removing hash keys", () => {
    const data = encode(SBookState.create({ BoardKey: 1n, Comment: "x".repeat(124) }));
    const copied = copy(data);
    expect(copied).toEqual(reencode(data));
    expect(data[1] & 0x80).not.toBe(0);
    expect(copied?.[1]).toBe(126);
  });

  it("omits explicit defaults but keeps empty repeated messages", () => {
    const data = Uint8Array.of(26, 14, 8, 0, 32, 0, 66, 0, 74, 2, 24, 0, 82, 2, 32, 0);
    expect(copy(data)).toEqual(reencode(data));
    expect(copy(data)).toEqual(Uint8Array.of(26, 4, 74, 0, 82, 0));
  });

  it("compacts a shortened nested length without overwriting following fields", () => {
    const writer = new BinaryWriter().uint32(26).fork();
    writer.uint32(82).fork().uint32(8).int32(0).uint32(42).string("a".repeat(124)).join();
    writer.uint32(82).fork().uint32(32).int64(1n).join();
    const data = writer.join().finish();
    expect(copy(data)).toEqual(reencode(data));
  });

  it.each([
    { name: "unknown field", payload: [88, 1] },
    { name: "unknown nested field", payload: [74, 2, 40, 1] },
    { name: "out-of-order fields", payload: [32, 1, 8, 1] },
    { name: "duplicate fields", payload: [8, 1, 8, 3] },
    { name: "wrong wire type", payload: [10, 1, 65] },
    { name: "non-minimal int32", payload: [8, 0x81, 0] },
    { name: "non-minimal nested length", payload: [74, 0x80, 0] },
    { name: "five-byte negative int32", payload: [8, 0xff, 0xff, 0xff, 0xff, 0x0f] },
    { name: "UTF-8 BOM", payload: [66, 4, 0xef, 0xbb, 0xbf, 65] },
    { name: "invalid UTF-8", payload: [66, 1, 0xff] },
  ])("falls back for $name", ({ payload }) => {
    expect(copy(Uint8Array.of(26, payload.length, ...payload))).toBeUndefined();
  });

  it("falls back for a non-minimal outer tag or length", () => {
    expect(copy(Uint8Array.of(0x9a, 0, 2, 8, 1))).toBeUndefined();
    expect(copy(Uint8Array.of(26, 0x82, 0, 8, 1))).toBeUndefined();
  });
});
