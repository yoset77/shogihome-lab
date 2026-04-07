import fs from "node:fs";
import path from "node:path";
import { RecordMetadataKey, ImmutableNode, getBlackPlayerName, getWhitePlayerName } from "tsshogi";
import { importRecordFromBuffer, detectRecordFileFormatByPath } from "@/common/file/record.js";
import { getNormalizedSfenAndHash } from "@/background/usi/sfen.js";
import { KifuFileMetadata, KifuPositionData } from "@/background/database/kifu_index.js";
import { getRecordTitleFromMetadata } from "@/common/helpers/metadata.js";

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

export async function parseAndIndexFile(
  baseDir: string,
  relativePath: string,
): Promise<{
  metadata: Omit<KifuFileMetadata, "indexed_at">;
  positions: KifuPositionData[];
} | null> {
  const fullPath = path.join(baseDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }

  const stats = fs.statSync(fullPath);
  const buffer = await fs.promises.readFile(fullPath);
  const format = detectRecordFileFormatByPath(relativePath);

  if (!format) {
    return null;
  }

  const record = importRecordFromBuffer(new Uint8Array(buffer), format, {
    autoDetect: true,
  });
  if (record instanceof Error) {
    console.error(`Failed to parse kifu file: ${relativePath}`, record.message);
    return null;
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
  };

  const positions: KifuPositionData[] = [];
  const visitedNodes = new Set<ImmutableNode>();

  function traverse(node: ImmutableNode) {
    if (visitedNodes.has(node)) {
      return;
    }
    visitedNodes.add(node);

    const normalized = getNormalizedSfenAndHash(node.sfen);
    if (normalized) {
      positions.push({
        sfen: normalized.sfen,
        sfen_hash: normalized.hash,
        ply: node.ply,
      });
    }

    for (let child = node.next; child; child = child.branch) {
      traverse(child);
    }
  }

  traverse(record.first);

  return { metadata, positions };
}
