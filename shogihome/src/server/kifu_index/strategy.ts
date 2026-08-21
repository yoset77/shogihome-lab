import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Move, PieceType, type ImmutableNode } from "tsshogi";
import { getBasePath } from "@/server/config";
import { searchableStrategies, type SearchableStrategy } from "@/common/kifu/strategy_taxonomy";

const RULE_VERSION = "rules-v2";
export const STRATEGY_INDEX_VERSION = 1;
const RULE_LOGIT_BONUS = 0.8;
const YAGURA_GANGI_COMBINED_THRESHOLD = 0.8;
const STANDARD_INITIAL_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

const STRATEGY_RULES = [
  {
    ply: 6,
    sfen: "ln1gkgsnl/1r1s3b1/p1pppp1pp/1p4p2/9/2P6/PPSPPPPPP/1B5R1/LN1GKGSNL b - 1",
    strategy: "矢倉",
  },
  {
    ply: 6,
    sfen: "lnsgkgsnl/1r5b1/p2ppp1pp/1pp3p2/9/2P6/PPSPPPPPP/1B5R1/LN1GKGSNL b - 1",
    strategy: "矢倉",
  },
  {
    ply: 6,
    sfen: "ln1gkgsnl/1rs4b1/p1pppp1pp/1p4p2/9/2P6/PPSPPPPPP/1B5R1/LN1GKGSNL b - 1",
    strategy: "矢倉",
  },
  {
    ply: 6,
    sfen: "lnsgk1snl/1r4gb1/p1ppppppp/9/1p5P1/9/PPPPPPP1P/1BG4R1/LNS1KGSNL b - 1",
    strategy: "相掛かり",
  },
  {
    ply: 11,
    sfen: "lnsgk1snl/1r4g2/p1pppp1pp/6p2/1p5P1/2P6/PPSPPPP1P/7R1/LN1GKGSNL w Bb 1",
    strategy: "角換わり",
  },
  {
    ply: 11,
    sfen: "lnsgk1snl/1r4g2/p1pppp1pp/6p2/1p7/2P4P1/PPSPPPP1P/2G4R1/LN2KGSNL w Bb 1",
    strategy: "角換わり",
  },
  {
    ply: 15,
    sfen: "lnsgk1snl/6gb1/p1pppp2p/6R2/9/1rP6/P2PPPP1P/1BG6/LNS1KGSNL w 3P2p 1",
    strategy: "横歩取り",
  },
] as const;

const BLACK_FURIBISHA_BY_FILE: Record<string, SearchableStrategy> = {
  "5": "中飛車",
  "6": "四間飛車",
  "7": "三間飛車",
  "8": "向かい飛車",
};

const WHITE_FURIBISHA_BY_FILE: Record<string, SearchableStrategy> = {
  "2": "向かい飛車",
  "3": "三間飛車",
  "4": "四間飛車",
  "5": "中飛車",
};

interface StrategyManifest {
  formatVersion: number;
  modelVersion: string;
  initialSfen: string;
  cutoff: number;
  mode: string;
  ngramMax: number;
  classes: string[];
  vocabulary: string[];
  coefficientShape: [number, number];
  acceptanceThresholds: Record<string, number>;
  coefficientSha256: string;
  interceptSha256: string;
}

interface StrategyModel {
  manifest: StrategyManifest;
  vocabulary: Map<string, number>;
  weights: Float64Array;
}

export interface StrategyInference {
  strategy: SearchableStrategy;
  score: number;
  modelVersion: string;
}

export interface StrategyRuleInference {
  strategy: SearchableStrategy;
  ruleVersion: string;
}

let loadedModel: StrategyModel | null | undefined;

const PIECE_SYMBOLS: Record<PieceType, string> = {
  [PieceType.PAWN]: "P",
  [PieceType.LANCE]: "L",
  [PieceType.KNIGHT]: "N",
  [PieceType.SILVER]: "S",
  [PieceType.GOLD]: "G",
  [PieceType.BISHOP]: "B",
  [PieceType.ROOK]: "R",
  [PieceType.KING]: "K",
  [PieceType.PROM_PAWN]: "+P",
  [PieceType.PROM_LANCE]: "+L",
  [PieceType.PROM_KNIGHT]: "+N",
  [PieceType.PROM_SILVER]: "+S",
  [PieceType.HORSE]: "+B",
  [PieceType.DRAGON]: "+R",
};

function resolveModelDirectory(): string | null {
  const basePath = getBasePath();
  const candidates = [
    path.join(basePath, "dist", "server", "models", "strategy"),
    path.join(basePath, "src", "server", "kifu_index", "models"),
    path.join(basePath, "shogihome", "dist", "server", "models", "strategy"),
    path.join(basePath, "shogihome", "src", "server", "kifu_index", "models"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function loadModel(): StrategyModel | null {
  if (loadedModel !== undefined) {
    return loadedModel;
  }

  try {
    const directory = resolveModelDirectory();
    if (!directory) {
      throw new Error("strategy model directory is missing");
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, "manifest.json"), "utf-8"),
    ) as StrategyManifest;
    if (
      manifest.formatVersion !== 1 ||
      typeof manifest.modelVersion !== "string" ||
      !manifest.modelVersion ||
      manifest.initialSfen !== STANDARD_INITIAL_SFEN ||
      manifest.mode !== "moves" ||
      manifest.cutoff !== 24 ||
      manifest.ngramMax !== 2 ||
      manifest.coefficientShape[0] !== manifest.classes.length ||
      manifest.coefficientShape[1] !== manifest.vocabulary.length ||
      manifest.classes.some(
        (strategy) => !searchableStrategies.includes(strategy as SearchableStrategy),
      ) ||
      new Set(manifest.classes).size !== manifest.classes.length ||
      !Object.values(manifest.acceptanceThresholds).every(
        (threshold) => Number.isFinite(threshold) && threshold > 0 && threshold <= 1,
      )
    ) {
      throw new Error("strategy model manifest is invalid");
    }

    const bytes = fs.readFileSync(path.join(directory, "weights.f64"));
    const expectedValues =
      manifest.coefficientShape[0] * manifest.coefficientShape[1] + manifest.classes.length;
    if (bytes.byteLength !== expectedValues * Float64Array.BYTES_PER_ELEMENT) {
      throw new Error("strategy model weights have an invalid length");
    }
    const coefficientByteLength =
      manifest.coefficientShape[0] * manifest.coefficientShape[1] * Float64Array.BYTES_PER_ELEMENT;
    const coefficientHash = createHash("sha256")
      .update(bytes.subarray(0, coefficientByteLength))
      .digest("hex");
    const interceptHash = createHash("sha256")
      .update(bytes.subarray(coefficientByteLength))
      .digest("hex");
    if (
      coefficientHash !== manifest.coefficientSha256 ||
      interceptHash !== manifest.interceptSha256
    ) {
      throw new Error("strategy model weights checksum is invalid");
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const weights = new Float64Array(buffer);
    if (![...weights].every(Number.isFinite)) {
      throw new Error("strategy model weights contain non-finite values");
    }
    loadedModel = {
      manifest,
      vocabulary: new Map(manifest.vocabulary.map((feature, index) => [feature, index])),
      weights,
    };
  } catch (error) {
    loadedModel = null;
    console.error("Failed to load strategy model:", error);
    return null;
  }
  return loadedModel;
}

function addFeature(features: Map<string, number>, key: string) {
  features.set(key, (features.get(key) ?? 0) + 1);
}

function extractFeatures(moves: Move[]): Map<string, number> {
  const features = new Map<string, number>();
  for (const [index, move] of moves.entries()) {
    const ply = index + 1;
    const usi = move.usi;
    addFeature(features, `ply=${ply}:${usi}`);
    addFeature(features, `side=${ply % 2 ? "b" : "w"}:${usi}`);
    if (usi.includes("*")) {
      const [piece, destination] = usi.split("*", 2);
      addFeature(features, `piece=${piece}`);
      addFeature(features, `destination=${destination}`);
      addFeature(features, "drop");
      continue;
    }
    addFeature(features, `piece=${PIECE_SYMBOLS[move.pieceType]}`);
    const source = usi.slice(0, 2);
    const destination = usi.slice(2, 4);
    addFeature(features, `source=${source}`);
    addFeature(features, `destination=${destination}`);
    addFeature(features, `move=${source}${destination}`);
    addFeature(features, usi.endsWith("+") ? "promotion" : "normal");
  }
  for (let index = 0; index < moves.length - 1; index++) {
    addFeature(features, `2gram=${moves[index].usi}|${moves[index + 1].usi}`);
  }
  return features;
}

function getMainlineNodes(first: ImmutableNode, cutoff: number): ImmutableNode[] | null {
  const nodes: ImmutableNode[] = [];
  for (let node = first.next; node && nodes.length < cutoff; node = node.next) {
    if (!(node.move instanceof Move)) {
      return null;
    }
    nodes.push(node);
  }
  return nodes.length === cutoff ? nodes : null;
}

interface BoardState {
  blackRookFile?: number;
  whiteRookFile?: number;
  bishopCount: number;
}

function getBoardState(sfen: string): BoardState {
  const board = sfen.split(" ", 1)[0].split("/");
  let blackRookFile: number | undefined;
  let whiteRookFile: number | undefined;
  let bishopCount = 0;

  for (const [rankIndex, rank] of board.entries()) {
    let file = 9;
    let promoted = false;
    for (const piece of rank) {
      if (/^[1-9]$/.test(piece)) {
        file -= Number(piece);
        continue;
      }
      if (piece === "+") {
        promoted = true;
        continue;
      }
      if (!promoted && (piece === "B" || piece === "b")) {
        bishopCount++;
      } else if (!promoted && piece === "R" && rankIndex >= 6) {
        blackRookFile = file;
      } else if (!promoted && piece === "r" && rankIndex <= 2) {
        whiteRookFile = file;
      }
      file--;
      promoted = false;
    }
  }

  return { blackRookFile, whiteRookFile, bishopCount };
}

function getFuribishaStrategies(sfen: string): SearchableStrategy[] {
  const { blackRookFile, whiteRookFile } = getBoardState(sfen);
  const strategies = [
    BLACK_FURIBISHA_BY_FILE[blackRookFile ?? ""],
    WHITE_FURIBISHA_BY_FILE[whiteRookFile ?? ""],
  ].filter((strategy): strategy is SearchableStrategy => strategy !== undefined);
  return strategies;
}

function getBonusStrategy(nodes: ImmutableNode[]): string | null {
  const last = nodes.at(-1);
  if (!last) {
    return null;
  }
  let blackHadBishop = false;
  let whiteHadBishop = false;
  for (const node of nodes) {
    const hands = node.sfen.split(" ")[2] ?? "";
    blackHadBishop ||= hands.includes("B");
    whiteHadBishop ||= hands.includes("b");
  }
  const furibishaStrategies = getFuribishaStrategies(last.sfen);
  if (furibishaStrategies.length === 1 && getBoardState(last.sfen).bishopCount === 2) {
    if (blackHadBishop && whiteHadBishop) {
      return "角交換型振り飛車";
    }
    return furibishaStrategies[0];
  }
  if (blackHadBishop && whiteHadBishop && furibishaStrategies.length === 1) {
    return "角交換型振り飛車";
  }
  if (furibishaStrategies.length === 2) {
    return "相振り飛車";
  }
  return null;
}

export function inferStrategyByRule(first: ImmutableNode): StrategyRuleInference | null {
  if (first.sfen !== STANDARD_INITIAL_SFEN) {
    return null;
  }
  let moves = 0;
  for (let node = first.next; node && moves < 24; node = node.next) {
    if (!(node.move instanceof Move)) {
      return null;
    }
    moves++;
    const rule = STRATEGY_RULES.find(
      (candidate) => candidate.ply === node.ply && candidate.sfen === node.sfen,
    );
    if (rule) {
      return { strategy: rule.strategy, ruleVersion: RULE_VERSION };
    }
  }
  return null;
}

export function inferStrategy(first: ImmutableNode): StrategyInference | null {
  const result = computeStrategyLogits(first);
  if (!result) {
    return null;
  }
  const { model, logits } = result;
  return selectStrategy(
    logits,
    model.manifest.classes,
    model.manifest.acceptanceThresholds,
    model.manifest.modelVersion,
  );
}

function computeStrategyLogits(
  first: ImmutableNode,
): { model: StrategyModel; logits: Float64Array } | null {
  const model = loadModel();
  if (!model || first.sfen !== model.manifest.initialSfen) {
    return null;
  }
  const nodes = getMainlineNodes(first, model.manifest.cutoff);
  if (!nodes) {
    return null;
  }
  const moves = nodes.map((node) => node.move as Move);

  const logits = new Float64Array(model.manifest.classes.length);
  const coefficientCount = model.manifest.coefficientShape[1];
  const interceptOffset = model.manifest.classes.length * coefficientCount;
  for (let classIndex = 0; classIndex < logits.length; classIndex++) {
    logits[classIndex] = model.weights[interceptOffset + classIndex];
  }
  for (const [feature, value] of extractFeatures(moves)) {
    const featureIndex = model.vocabulary.get(feature);
    if (featureIndex === undefined) {
      continue;
    }
    for (let classIndex = 0; classIndex < logits.length; classIndex++) {
      logits[classIndex] += value * model.weights[classIndex * coefficientCount + featureIndex];
    }
  }

  const bonusStrategy = getBonusStrategy(nodes);
  if (bonusStrategy) {
    const bonusIndex = model.manifest.classes.indexOf(bonusStrategy);
    if (bonusIndex >= 0) {
      logits[bonusIndex] += RULE_LOGIT_BONUS;
    }
  }
  return { model, logits };
}

function pickTopStrategy(
  logits: Float64Array,
  classes: readonly string[],
  excluded: readonly number[] = [],
): { index: number; score: number } {
  let maxLogit = -Infinity;
  let bestIndex = -1;
  for (let index = 0; index < logits.length; index++) {
    if (excluded.includes(index)) {
      continue;
    }
    if (logits[index] > maxLogit) {
      maxLogit = logits[index];
      bestIndex = index;
    }
  }
  if (bestIndex < 0) {
    return { index: -1, score: 0 };
  }
  let denominator = 0;
  for (let index = 0; index < logits.length; index++) {
    if (excluded.includes(index)) {
      continue;
    }
    denominator += Math.exp(logits[index] - maxLogit);
  }
  return { index: bestIndex, score: 1 / denominator };
}

function getSoftmaxScore(logits: Float64Array, targetIndex: number): number {
  let maxLogit = -Infinity;
  for (const logit of logits) {
    maxLogit = Math.max(maxLogit, logit);
  }

  let denominator = 0;
  for (const logit of logits) {
    denominator += Math.exp(logit - maxLogit);
  }
  return Math.exp(logits[targetIndex] - maxLogit) / denominator;
}

export function selectStrategy(
  logits: Float64Array,
  classes: readonly string[],
  acceptanceThresholds: Record<string, number>,
  modelVersion: string,
): StrategyInference | null {
  const top = pickTopStrategy(logits, classes);
  if (top.index < 0) {
    return null;
  }
  const topStrategy = classes[top.index];
  const topThreshold = acceptanceThresholds[topStrategy];
  if (topThreshold !== undefined && top.score >= topThreshold) {
    return { strategy: topStrategy as SearchableStrategy, score: top.score, modelVersion };
  }

  const otherIndex = classes.indexOf("その他");
  if (otherIndex >= 0 && top.index === otherIndex) {
    const fallback = pickTopStrategy(logits, classes, [otherIndex]);
    if (fallback.index >= 0) {
      const fallbackStrategy = classes[fallback.index];
      if (fallbackStrategy === "矢倉" || fallbackStrategy === "雁木") {
        const threshold = acceptanceThresholds[fallbackStrategy];
        if (threshold !== undefined && fallback.score >= threshold) {
          return {
            strategy: fallbackStrategy as SearchableStrategy,
            score: fallback.score,
            modelVersion,
          };
        }
      }
    }
  }

  const yaguraIndex = classes.indexOf("矢倉");
  const gangiIndex = classes.indexOf("雁木");
  if (
    (top.index === yaguraIndex || top.index === gangiIndex) &&
    yaguraIndex >= 0 &&
    gangiIndex >= 0
  ) {
    const combinedScore =
      getSoftmaxScore(logits, yaguraIndex) + getSoftmaxScore(logits, gangiIndex);
    if (combinedScore >= YAGURA_GANGI_COMBINED_THRESHOLD) {
      return { strategy: topStrategy as SearchableStrategy, score: top.score, modelVersion };
    }
  }
  return null;
}

export function isStrategyModelAvailable(): boolean {
  return loadModel() !== null;
}

export function requiresStrategyInference(first: ImmutableNode): boolean {
  if (first.sfen !== STANDARD_INITIAL_SFEN) {
    return false;
  }
  return getMainlineNodes(first, 24) !== null;
}

export function inferStrategyCandidate(first: ImmutableNode): StrategyInference | null {
  const result = computeStrategyLogits(first);
  if (!result) {
    return null;
  }
  const { model, logits } = result;
  const top = pickTopStrategy(logits, model.manifest.classes);
  if (top.index < 0) {
    return null;
  }
  const strategy = model.manifest.classes[top.index] as SearchableStrategy;
  return { strategy, score: top.score, modelVersion: model.manifest.modelVersion };
}
