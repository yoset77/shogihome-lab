import { describe, expect, it } from "vitest";
import { importKIF } from "tsshogi";
import { generateSfenLines } from "@/server/kifu_export/sfen";
import { normalizeSfen } from "@/common/usi/sfen";

function parseRecord(lines: string[]) {
  const record = importKIF(lines.join("\n"));
  if (record instanceof Error) {
    throw record;
  }
  return record;
}

const branchedRecord = () =>
  parseRecord([
    "手合割：平手",
    "先手番",
    "手数----指手----消費時間--",
    "1 ７六歩(77)",
    "2 ３四歩(33)",
    "3 ２六歩(27)",
    "4 投了",
    "変化：3手",
    "3 ７八金(69)",
    "4 ８四歩(83)",
  ]);

describe("kifu_export/sfen", () => {
  it("outputs one position command for each leaf and omits terminal moves", () => {
    expect([...generateSfenLines(branchedRecord())]).toEqual([
      "position startpos moves 7g7f 3c3d 2g2f",
      "position startpos moves 7g7f 3c3d 6i7h 8c8d",
    ]);
  });

  it("uses the initial SFEN for non-standard records and can exclude them", () => {
    const record = parseRecord([
      "手合割：二枚落ち",
      "上手番",
      "手数----指手----消費時間--",
      "1 ６二銀(71)",
    ]);

    expect([...generateSfenLines(record)]).toEqual([
      `position sfen ${record.initialPosition.sfen} moves 7a6b`,
    ]);
    expect([...generateSfenLines(record, { standardInitialOnly: true })]).toEqual([]);
  });

  it("outputs only branches containing the searched position", () => {
    const record = branchedRecord();
    const branchPosition = [...collectNodes(record)].find(
      (node) => node.ply === 3 && node.branchIndex > 0,
    );
    if (!branchPosition) throw new Error("branch position not found");

    expect([
      ...generateSfenLines(record, { targetSfen: normalizeSfen(branchPosition.sfen) }),
    ]).toEqual(["position startpos moves 7g7f 3c3d 6i7h 8c8d"]);
  });

  it("treats a matching initial position as part of every branch", () => {
    const record = branchedRecord();
    expect([
      ...generateSfenLines(record, { targetSfen: normalizeSfen(record.first.sfen) }),
    ]).toHaveLength(2);
  });

  it("truncates at maxMoves and emits a shared prefix only once", () => {
    expect([...generateSfenLines(branchedRecord(), { maxMoves: 2 })]).toEqual([
      "position startpos moves 7g7f 3c3d",
    ]);
  });

  it("does not output a branch when the searched position is beyond maxMoves", () => {
    const record = branchedRecord();
    const target = [...collectNodes(record)].find((node) => node.ply === 3 && node.branchIndex > 0);
    if (!target) throw new Error("target position not found");

    expect([
      ...generateSfenLines(record, {
        maxMoves: 2,
        targetSfen: normalizeSfen(target.sfen),
      }),
    ]).toEqual([]);
  });
});

function* collectNodes(record: ReturnType<typeof branchedRecord>) {
  const stack = [record.first];
  while (stack.length > 0) {
    const node = stack.pop()!;
    yield node;
    const children = [];
    for (let child = node.next; child; child = child.branch) {
      children.push(child);
    }
    stack.push(...children.reverse());
  }
}
