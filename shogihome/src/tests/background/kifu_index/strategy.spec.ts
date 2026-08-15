import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Record } from "tsshogi";
import {
  inferStrategy,
  inferStrategyByRule,
  inferStrategyCandidate,
  selectStrategy,
} from "@/server/kifu_index/strategy";

interface Manifest {
  classes: string[];
  acceptanceThresholds: { [key: string]: number };
}

function loadManifest(): Manifest {
  const manifestPath = path.join(
    process.cwd(),
    "src",
    "server",
    "kifu_index",
    "models",
    "manifest.json",
  );
  return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
}

const AIGAKARI_MOVES = [
  "2g2f",
  "8c8d",
  "2f2e",
  "8d8e",
  "6i7h",
  "4a3b",
  "2e2d",
  "2c2d",
  "2h2d",
  "P*2c",
  "2d2f",
  "7a6b",
  "1g1f",
  "1c1d",
  "3i3h",
  "3c3d",
  "7g7f",
  "8e8f",
  "8g8f",
  "8b8f",
  "P*2d",
  "2c2d",
  "2f2d",
  "8f8e",
] as const;

const RULE_CASES = [
  {
    name: "Tango",
    strategy: "相掛かり",
    moves: [
      "2g2f",
      "8c8d",
      "2f2e",
      "8d8e",
      "6i7h",
      "4a3b",
      "3i3h",
      "7a7b",
      "5i5h",
      "8e8f",
      "8g8f",
      "8b8f",
      "P*8g",
      "8f8d",
      "7g7f",
      "8d7d",
      "7h7g",
      "3a4b",
      "4g4f",
      "3c3d",
      "3g3f",
      "2b3c",
      "2i3g",
      "7d8d",
    ],
  },
  {
    name: "Ryfamate",
    strategy: "角換わり",
    moves: [
      "2g2f",
      "4a3b",
      "2f2e",
      "8c8d",
      "7g7f",
      "8d8e",
      "8h7g",
      "3c3d",
      "7i8h",
      "2b7g",
      "8h7g",
      "3a2b",
      "1g1f",
      "1c1d",
      "6i7h",
      "2b3c",
      "3i4h",
      "6c6d",
      "4g4f",
      "6a6b",
      "3g3f",
      "7c7d",
      "9g9f",
      "8a7c",
    ],
  },
] as const;

const SANGENBISHA_MOVES = [
  "2h7h",
  "3c3d",
  "7i6h",
  "4a4b",
  "7g7f",
  "8c8d",
  "6g6f",
  "5a4a",
  "5i4h",
  "8d8e",
  "8h7g",
  "1c1d",
  "4h3h",
  "7a6b",
  "3h2h",
  "1d1e",
  "6i5h",
  "5c5d",
  "1i1h",
  "2b3c",
  "2h1i",
  "6b5c",
  "3i2h",
  "4a3b",
] as const;

const YAGURA_SFENS = [
  "ln1gkgsnl/1r1s3b1/p1pppp1pp/1p4p2/9/2P6/PPSPPPPPP/1B5R1/LN1GKGSNL b - 1",
  "lnsgkgsnl/1r5b1/p2ppp1pp/1pp3p2/9/2P6/PPSPPPPPP/1B5R1/LN1GKGSNL b - 1",
  "ln1gkgsnl/1rs4b1/p1pppp1pp/1p4p2/9/2P6/PPSPPPPPP/1B5R1/LN1GKGSNL b - 1",
] as const;

const YOKOFUDORI_SFEN = "lnsgk1snl/6gb1/p1pppp2p/6R2/9/1rP6/P2PPPP1P/1BG6/LNS1KGSNL w 3P2p 1";

function createRecord(moves: readonly string[]): Record {
  const record = new Record();
  for (const usi of moves) {
    const move = record.position.createMoveByUSI(usi);
    if (!move || !record.append(move)) {
      throw new Error(`failed to append ${usi}`);
    }
  }
  return record;
}

describe("background/kifu_index/strategy", () => {
  it("classifies a known 24-ply mainline with the portable model", () => {
    const result = inferStrategy(createRecord(AIGAKARI_MOVES).first);

    expect(result).toMatchObject({ strategy: "相掛かり", modelVersion: "v4-12-24-moves-clean" });
    expect(result?.score).toBeGreaterThanOrEqual(0.8);
  });

  it("rejects records shorter than the model cutoff", () => {
    expect(inferStrategy(createRecord(AIGAKARI_MOVES.slice(0, -1)).first)).toBeNull();
    expect(inferStrategyCandidate(createRecord(AIGAKARI_MOVES.slice(0, -1)).first)).toBeNull();
  });

  it.each(RULE_CASES)("exposes the exact-SFEN rule for the $name case", ({ moves, strategy }) => {
    const record = createRecord(moves);

    expect(inferStrategyByRule(record.first)).toEqual({ strategy, ruleVersion: "rules-v2" });
  });

  it.each(YAGURA_SFENS)("classifies the exact 6-ply Yagura position", (sfen) => {
    const record = createRecord(AIGAKARI_MOVES);
    const node = record.first.next;
    if (!node) {
      throw new Error("missing sample move");
    }
    const first = {
      sfen: record.first.sfen,
      next: { move: node.move, ply: 6, sfen, next: null },
    } as unknown as typeof record.first;

    expect(inferStrategyByRule(first)).toEqual({ strategy: "矢倉", ruleVersion: "rules-v2" });
  });

  it("classifies the exact 15-ply Yokofudori position", () => {
    const record = createRecord(AIGAKARI_MOVES);
    const node = record.first.next;
    if (!node) {
      throw new Error("missing sample move");
    }
    const first = {
      sfen: record.first.sfen,
      next: { move: node.move, ply: 15, sfen: YOKOFUDORI_SFEN, next: null },
    } as unknown as typeof record.first;

    expect(inferStrategyByRule(first)).toEqual({
      strategy: "横歩取り",
      ruleVersion: "rules-v2",
    });
  });

  it("accepts the known 三間飛車 case with a logit bonus", () => {
    const result = inferStrategy(createRecord(SANGENBISHA_MOVES).first);

    expect(result?.strategy).toBe("三間飛車");
    expect(result?.score).toBeGreaterThanOrEqual(0.8);
    expect(result?.score).toBeGreaterThan(0.9);
  });

  it("does not classify a 24-ply furibisha as an immediate rule result", () => {
    const record = createRecord(SANGENBISHA_MOVES);

    expect(inferStrategyByRule(record.first)).toBeNull();
  });

  it("returns the top candidate independently of acceptance thresholds", () => {
    const result = inferStrategyCandidate(createRecord(AIGAKARI_MOVES).first);

    expect(result).toMatchObject({ strategy: "相掛かり", modelVersion: "v4-12-24-moves-clean" });
    expect(result?.score).toBeGreaterThan(0);
  });
});

describe("background/kifu_index/strategy selectStrategy", () => {
  const YAGURA_GANGI_THRESHOLDS = { 矢倉: 0.8, 雁木: 0.8 };

  it("accepts a non-その他 top class that clears its threshold", () => {
    const classes = ["矢倉", "その他"];
    const logits = new Float64Array([5, 0]);

    const result = selectStrategy(logits, classes, YAGURA_GANGI_THRESHOLDS, "m");

    expect(result?.strategy).toBe("矢倉");
  });

  it("falls back to Yagura when その他 is the top class", () => {
    const classes = ["矢倉", "その他"];
    const logits = new Float64Array([0, 5]);

    const result = selectStrategy(logits, classes, YAGURA_GANGI_THRESHOLDS, "m");

    expect(result?.strategy).toBe("矢倉");
    expect(result?.score).toBeGreaterThanOrEqual(0.8);
  });

  it("falls back to Gangi when その他 is the top class", () => {
    const classes = ["雁木", "その他"];
    const logits = new Float64Array([0, 5]);

    const result = selectStrategy(logits, classes, YAGURA_GANGI_THRESHOLDS, "m");

    expect(result?.strategy).toBe("雁木");
  });

  it("does not fall back to non-Yagura/Gangi classes when その他 is the top", () => {
    const classes = ["三間飛車", "その他"];
    const logits = new Float64Array([0, 5]);

    const result = selectStrategy(logits, classes, { 三間飛車: 0.8 }, "m");

    expect(result).toBeNull();
  });

  it("rejects the fallback when its score is below the threshold", () => {
    const classes = ["x", "矢倉", "その他", "y"];
    const logits = new Float64Array([0, 5, 6, 4]);

    const result = selectStrategy(logits, classes, YAGURA_GANGI_THRESHOLDS, "m");

    expect(result).toBeNull();
  });

  it("uses the manifest acceptance thresholds for Yagura and Gangi", () => {
    const manifest = loadManifest();
    expect(manifest.classes).toContain("その他");
    expect(manifest.acceptanceThresholds["矢倉"]).toBe(0.8);
    expect(manifest.acceptanceThresholds["雁木"]).toBe(0.8);
  });
});
