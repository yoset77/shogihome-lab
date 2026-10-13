import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import {
  MAX_BATCH_FILES,
  type BatchAnalysisSource,
  type BatchAnalysisPlan,
  type BatchFileOptions,
} from "@/common/analysis/batch";
import {
  detectRecordFileFormatByPath,
  getStandardRecordFileFormats,
  importRecordFromBuffer,
  exportRecordAsBuffer,
  type RecordFileFormat,
} from "@/common/file/record";
import { parseComment } from "@/common/record/comment";
import {
  snapshotRecord,
  restoreRecord,
  decodeRecordSnapshot,
  type RecordSnapshot,
} from "@/common/record/snapshot";
import { isReservedServerEntryName } from "@/common/file/upload";
import {
  resolveKifuDirectory,
  resolveIndexableKifuPath,
  resolveWritableKifuPath,
  clearKifuListCache,
} from "@/server/helpers/kifu";
import { getKifuSearchFilePaths } from "@/server/database/kifu_index";
import { getNormalizedSfenAndHash } from "@/server/usi/sfen";
import { writeStreamAtomic } from "@/server/file/atomic_stream";
import { LARGE_BODY_LIMIT } from "@/server/hono";
import { HttpError } from "@/server/errors";
import { t } from "@/common/i18n";

const PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_RETAINED_PLANS = 10;
const MAX_PREPARING_PLANS = 10;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_SCANNED_ENTRIES = 100_000;
const PLAN_SCAN_MS = 30_000;
export class BatchFileError extends Error {
  constructor(readonly reason: "read" | "invalid" | "save" | "changed") {
    super(reason);
  }
}
export type LoadedBatchFile = {
  path: string;
  root: string;
  fullPath: string;
  signature: string;
  location: string;
  hash: string;
  format: RecordFileFormat;
  source: RecordSnapshot;
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const signature = (stat: Stats) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
async function location(root: string, fullPath: string): Promise<string> {
  const directories = [path.resolve(root)];
  for (const segment of path.relative(root, path.dirname(fullPath)).split(path.sep).filter(Boolean))
    directories.push(path.join(directories[directories.length - 1], segment));
  return (
    await Promise.all(
      directories.map(async (directory) => {
        const stat = await fs.stat(directory);
        return `${stat.dev}:${stat.ino}`;
      }),
    )
  ).join("/");
}

export class BatchAnalysisFiles {
  private plans = new Map<string, BatchAnalysisPlan>();
  private preparing = 0;
  constructor(private readonly directory: () => string | undefined | null) {}
  async prepare(source: BatchAnalysisSource): Promise<BatchAnalysisPlan> {
    for (const [id, plan] of this.plans) if (plan.expiresAt <= Date.now()) this.plans.delete(id);
    if (this.preparing >= MAX_PREPARING_PLANS) throw new HttpError(503, t.analysisJobCapacity);
    this.preparing++;
    try {
      return await this.enumerate(source);
    } finally {
      this.preparing--;
    }
  }
  private async enumerate(source: BatchAnalysisSource): Promise<BatchAnalysisPlan> {
    const root = this.directory();
    if (!root) throw new HttpError(400, t.batchAnalysisInvalid);
    let files: string[] = [];
    if (source.kind === "folder") {
      let scanned = 0;
      const deadline = Date.now() + PLAN_SCAN_MS;
      const folder = resolveKifuDirectory(root, source.directory);
      if (!folder) throw new HttpError(400, t.batchAnalysisInvalid);
      const walk = async (folder: string, depth: number) => {
        if (depth > 10) throw new HttpError(413, t.analysisJobCapacity);
        for await (const entry of await fs.opendir(folder)) {
          if (++scanned > MAX_SCANNED_ENTRIES || Date.now() >= deadline)
            throw new HttpError(413, t.analysisJobCapacity);
          if (entry.isSymbolicLink() || isReservedServerEntryName(entry.name)) continue;
          const fullPath = path.join(folder, entry.name);
          if (entry.isDirectory() && source.subdirectories) {
            const relative = path.relative(root, fullPath).split(path.sep).join("/");
            if (!resolveKifuDirectory(root, relative))
              throw new HttpError(400, t.batchAnalysisInvalid);
            await walk(fullPath, depth + 1);
          } else if (
            entry.isFile() &&
            getStandardRecordFileFormats().includes(detectRecordFileFormatByPath(entry.name)!)
          ) {
            files.push(path.relative(root, fullPath).split(path.sep).join("/"));
            if (files.length > MAX_BATCH_FILES) throw new HttpError(413, t.analysisJobCapacity);
          }
        }
      };
      await walk(folder, 0);
      files.sort();
    } else {
      const position = source.search.sfen && getNormalizedSfenAndHash(source.search.sfen);
      if (source.search.sfen && !position) throw new HttpError(400, t.batchAnalysisInvalid);
      files = getKifuSearchFilePaths(
        { ...source.search, ...(position ? { sfen: position.sfen, sfenHash: position.hash } : {}) },
        { strict: true, limit: MAX_BATCH_FILES },
      );
      if (files.length > MAX_BATCH_FILES) throw new HttpError(413, t.analysisJobCapacity);
    }
    if (!files.length) throw new HttpError(400, t.batchAnalysisNoFiles);
    if (
      Buffer.byteLength(JSON.stringify(files)) > MAX_PLAN_BYTES ||
      files.some((file) => file.length > 1024)
    )
      throw new HttpError(413, t.analysisJobCapacity);
    const plan = {
      planId: randomUUID(),
      files: [...new Set(files)],
      expiresAt: Date.now() + PLAN_TTL_MS,
    };
    if (this.plans.size >= MAX_RETAINED_PLANS) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.planId, plan);
    return structuredClone(plan);
  }
  get(id: string): BatchAnalysisPlan {
    const plan = this.plans.get(id);
    if (!plan || plan.expiresAt <= Date.now()) throw new HttpError(410, t.batchAnalysisPlanExpired);
    return structuredClone(plan);
  }
  release(id: string): void {
    this.plans.delete(id);
  }
  async load(relative: string, autoDetect: boolean): Promise<LoadedBatchFile> {
    const root = this.directory();
    const fullPath = root && resolveIndexableKifuPath(root, relative);
    const format = detectRecordFileFormatByPath(relative);
    if (!root || !fullPath || !getStandardRecordFileFormats().includes(format!))
      throw new BatchFileError("read");
    if (resolveWritableKifuPath(root, "kifu", relative) !== fullPath)
      throw new BatchFileError("save");
    let data: Buffer;
    let original: string;
    let originalLocation: string;
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile() || stat.size > LARGE_BODY_LIMIT) throw new BatchFileError("invalid");
      original = signature(stat);
      originalLocation = await location(root, fullPath);
      data = await fs.readFile(fullPath);
      if (
        data.length > LARGE_BODY_LIMIT ||
        signature(await fs.stat(fullPath)) !== original ||
        resolveIndexableKifuPath(root, relative) !== fullPath ||
        (await location(root, fullPath)) !== originalLocation
      )
        throw new BatchFileError("changed");
    } catch (error) {
      if (error instanceof BatchFileError) throw error;
      throw new BatchFileError("read");
    }
    try {
      const record = importRecordFromBuffer(data, format!, { autoDetect });
      if (record instanceof Error) throw record;
      record.forEach((node) => {
        node.customData = parseComment(node.comment);
      });
      record.resetAllBranchSelection();
      record.goto(0);
      const source = decodeRecordSnapshot(snapshotRecord(record));
      if (!source.ok) throw new BatchFileError("invalid");
      return {
        path: relative,
        root,
        fullPath,
        format: format!,
        signature: original,
        location: originalLocation,
        hash: digest(data),
        source: source.value,
      };
    } catch {
      throw new BatchFileError("invalid");
    }
  }
  async save(
    loaded: LoadedBatchFile,
    source: RecordSnapshot,
    options: BatchFileOptions,
  ): Promise<void> {
    try {
      if (resolveIndexableKifuPath(loaded.root, loaded.path) !== loaded.fullPath)
        throw new BatchFileError("changed");
      if (resolveWritableKifuPath(loaded.root, "kifu", loaded.path) !== loaded.fullPath)
        throw new BatchFileError("save");
      const data = exportRecordAsBuffer(restoreRecord(source).record, loaded.format, {
        returnCode: options.returnCode,
        csa: { v3: options.useCSAV3 },
        useUTF8ForKifAndKi2: options.useUTF8ForKifAndKi2,
        detectGarbled: true,
      });
      if (data.garbled || data.data.byteLength > LARGE_BODY_LIMIT) throw new BatchFileError("save");
      await writeStreamAtomic(
        loaded.fullPath,
        async (stream) => {
          stream.end(data.data);
          await finished(stream);
        },
        {
          overwrite: true,
          beforePublish: async () => {
            if (
              this.directory() !== loaded.root ||
              resolveWritableKifuPath(loaded.root, "kifu", loaded.path) !== loaded.fullPath
            )
              throw new BatchFileError("changed");
            const stat = await fs.stat(loaded.fullPath).catch(() => undefined);
            if (
              !stat ||
              signature(stat) !== loaded.signature ||
              stat.size > LARGE_BODY_LIMIT ||
              digest(await fs.readFile(loaded.fullPath)) !== loaded.hash ||
              signature(await fs.stat(loaded.fullPath)) !== loaded.signature ||
              (await location(loaded.root, loaded.fullPath)) !== loaded.location ||
              resolveIndexableKifuPath(loaded.root, loaded.path) !== loaded.fullPath
            )
              throw new BatchFileError("changed");
          },
          onPublished: clearKifuListCache,
        },
      );
    } catch (error) {
      if (error instanceof BatchFileError) throw error;
      throw new BatchFileError("save");
    }
  }
}
