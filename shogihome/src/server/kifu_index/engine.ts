import fs from "node:fs";
import { resolveIndexableKifuPath } from "@/server/helpers/kifu";
import {
  RecordMetadataKey,
  Move,
  Position,
  formatMove,
  formatSpecialMove,
  getBlackPlayerName,
  getWhitePlayerName,
  type ImmutableNode,
} from "tsshogi";
import { importRecordFromBuffer, detectRecordFileFormatByPath } from "@/common/file/record";
import { normalizeSfen } from "@/common/usi/sfen";
import { hashPosition } from "@/server/book/apery_zobrist";
import {
  KifuFileMetadata,
  KifuPositionData,
  KIFU_POSITION_INDEX_VERSION,
} from "@/server/database/kifu_index";
import { iterateKifuNodes } from "@/common/kifu/position";
import { getRecordTitleFromMetadata } from "@/common/helpers/metadata";
import { normalizeManualStrategy } from "@/common/kifu/strategy_taxonomy";
import {
  inferStrategy,
  inferStrategyByRule,
  isStrategyModelAvailable,
  requiresStrategyInference,
  STRATEGY_INDEX_VERSION,
} from "@/server/kifu_index/strategy";

function normalizeDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined;
  const m = dateStr.match(/(\d{4})[/\-年\s](\d{1,2})[/\-月\s](\d{1,2})/);
  if (m) {
    return `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
  }
  const m2 = dateStr.match(/(\d{4})[/\-年\s](\d{1,2})/);
  if (m2) {
    return `${m2[1]}/${m2[2].padStart(2, "0")}`;
  }
  const m3 = dateStr.match(/(\d{4})/);
  if (m3) {
    return m3[1];
  }
  return undefined;
}

function parseIndexedPosition(sfen: string) {
  try {
    const position = Position.newBySFEN(sfen);
    if (!position) {
      console.warn("Invalid SFEN string:", sfen);
      return null;
    }
    return {
      position,
      sfen: normalizeSfen(position.sfen),
      hash: BigInt.asIntN(64, hashPosition(position)),
    };
  } catch (error) {
    console.warn("Failed to parse kifu index position:", error);
    return null;
  }
}

export async function parseKifuFile(
  baseDir: string,
  relativePath: string,
): Promise<{
  metadata: Omit<KifuFileMetadata, "indexed_at">;
  first: ImmutableNode;
} | null> {
  const format = detectRecordFileFormatByPath(relativePath);
  if (!format) return null;
  const fullPath = resolveIndexableKifuPath(baseDir, relativePath);
  if (!fullPath) return null;
  let file: fs.promises.FileHandle;
  try {
    file = await fs.promises.open(fullPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  let stats: fs.Stats;
  let buffer: Buffer;
  try {
    stats = await file.stat();
    if (!stats.isFile() || resolveIndexableKifuPath(baseDir, relativePath) !== fullPath)
      return null;
    buffer = await file.readFile();
  } finally {
    await file.close();
  }

  const record = importRecordFromBuffer(buffer, format, {
    autoDetect: true,
  });
  if (record instanceof Error) {
    console.error(`Failed to parse kifu file: ${relativePath}`, record.message);
    return null;
  }

  const manualStrategy = normalizeManualStrategy(
    record.metadata.getStandardMetadata(RecordMetadataKey.STRATEGY),
  );
  const ruleStrategy = manualStrategy.raw ? undefined : inferStrategyByRule(record.first);
  let inferredStrategy;
  let strategyIndexVersion: number | undefined = STRATEGY_INDEX_VERSION;
  if (!manualStrategy.raw && !ruleStrategy && requiresStrategyInference(record.first)) {
    if (!isStrategyModelAvailable()) {
      strategyIndexVersion = undefined;
    } else {
      try {
        inferredStrategy = inferStrategy(record.first);
      } catch (error) {
        console.error(`Failed to infer strategy for kifu file: ${relativePath}`, error);
        strategyIndexVersion = undefined;
      }
    }
  }
  const metadata: Omit<KifuFileMetadata, "indexed_at"> = {
    file_path: relativePath,
    mtime: stats.mtimeMs,
    size: stats.size,
    black_name: getBlackPlayerName(record.metadata),
    white_name: getWhitePlayerName(record.metadata),
    start_date: normalizeDate(
      record.metadata.getStandardMetadata(RecordMetadataKey.START_DATETIME) ||
        record.metadata.getStandardMetadata(RecordMetadataKey.DATE),
    ),
    event: getRecordTitleFromMetadata(record.metadata),
    strategy: manualStrategy.strategy || ruleStrategy?.strategy || inferredStrategy?.strategy,
    strategy_raw: manualStrategy.raw,
    strategy_source: manualStrategy.raw
      ? "metadata"
      : ruleStrategy
        ? "rule"
        : inferredStrategy
          ? "inferred"
          : undefined,
    strategy_score: inferredStrategy?.score,
    strategy_classifier_version: ruleStrategy?.ruleVersion || inferredStrategy?.modelVersion,
    strategy_index_version: strategyIndexVersion,
    position_index_version: KIFU_POSITION_INDEX_VERSION,
  };
  return { metadata, first: record.first };
}

export function buildKifuPositions(first: ImmutableNode): KifuPositionData[] {
  const positions: KifuPositionData[] = [];
  for (const { node, isVariation } of iterateKifuNodes(first)) {
    const indexed = parseIndexedPosition(node.sfen);
    if (!indexed) continue;
    positions.push({
      sfen: indexed.sfen,
      sfen_hash: indexed.hash,
      ply: node.ply,
      next_move: !node.next
        ? ""
        : node.next.move instanceof Move
          ? formatMove(indexed.position, node.next.move)
          : formatSpecialMove(node.next.move, node.nextColor),
      is_variation: isVariation,
    });
  }

  return positions;
}
