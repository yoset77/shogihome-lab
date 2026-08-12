import fs from "node:fs";
import crypto from "node:crypto";
import { finished } from "node:stream/promises";
import { detectRecordFileFormatByPath, importRecordFromBuffer } from "@/common/file/record";
import type { SfenExportJobStatus } from "@/common/file/sfen_export";
import type { KifuSearchParams } from "@/server/database/kifu_index";
import { getKifuSearchFilePaths } from "@/server/database/kifu_index";
import { clearKifuListCache, resolveKifuPath } from "@/server/helpers/kifu";
import { writeStreamAtomic } from "@/server/file/atomic_stream";
import { generateSfenLines, isStandardInitialRecord } from "@/server/kifu_export/sfen";

const COMPLETED_JOB_TTL_MS = 10 * 60 * 1000;
const OUTPUT_BUFFER_SIZE = 64 * 1024;

export interface StartSfenExportJobParams {
  kifuDir: string;
  outputPath: string;
  search: KifuSearchParams;
  targetSfen?: string;
  maxMoves?: number;
  standardInitialOnly: boolean;
  overwrite: boolean;
}

interface InternalJob {
  status: SfenExportJobStatus;
  cancelRequested: boolean;
  completedAt?: number;
}

const jobs = new Map<string, InternalJob>();
let activeJobId: string | undefined;

export function startSfenExportJob(
  params: StartSfenExportJobParams,
): SfenExportJobStatus | undefined {
  cleanupJobs();
  if (activeJobId) {
    return undefined;
  }

  const filePaths = getKifuSearchFilePaths(params.search);
  const jobId = crypto.randomUUID();
  const job: InternalJob = {
    status: {
      jobId,
      state: "queued",
      outputPath: params.outputPath,
      totalFiles: filePaths.length,
      processedFiles: 0,
      exportedLines: 0,
      failedFiles: 0,
    },
    cancelRequested: false,
  };
  jobs.set(jobId, job);
  activeJobId = jobId;
  setImmediate(() => runJob(job, params, filePaths));
  return { ...job.status };
}

export function getSfenExportJob(jobId: string): SfenExportJobStatus | undefined {
  cleanupJobs();
  const job = jobs.get(jobId);
  return job ? { ...job.status } : undefined;
}

export function cancelSfenExportJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || !["queued", "running"].includes(job.status.state)) {
    return false;
  }
  job.cancelRequested = true;
  return true;
}

async function runJob(
  job: InternalJob,
  params: StartSfenExportJobParams,
  filePaths: string[],
): Promise<void> {
  job.status.state = "running";
  const destination = resolveKifuPath(params.kifuDir, params.outputPath);
  if (!destination) {
    finishJob(job, "failed", "Invalid output path");
    return;
  }

  try {
    await writeStreamAtomic(
      destination,
      async (stream) => {
        let outputBuffer = "";
        const flush = async () => {
          if (!outputBuffer) return;
          if (!stream.write(outputBuffer)) {
            await new Promise<void>((resolve, reject) => {
              const onDrain = () => {
                cleanup();
                resolve();
              };
              const onError = (error: Error) => {
                cleanup();
                reject(error);
              };
              const onClose = () => {
                cleanup();
                reject(new Error("SFEN output stream closed before draining"));
              };
              const cleanup = () => {
                stream.off("drain", onDrain);
                stream.off("error", onError);
                stream.off("close", onClose);
              };
              stream.once("drain", onDrain);
              stream.once("error", onError);
              stream.once("close", onClose);
            });
          }
          outputBuffer = "";
        };

        for (const relativePath of filePaths) {
          if (job.cancelRequested) {
            throw new ExportCancelledError();
          }
          let lines: Generator<string> | undefined;
          try {
            const sourcePath = resolveKifuPath(params.kifuDir, relativePath);
            const format = detectRecordFileFormatByPath(relativePath);
            if (!sourcePath || !format) {
              throw new Error("Invalid source path or format");
            }
            const record = importRecordFromBuffer(await fs.promises.readFile(sourcePath), format, {
              autoDetect: true,
            });
            if (record instanceof Error) {
              throw record;
            }
            if (!params.standardInitialOnly || isStandardInitialRecord(record)) {
              lines = generateSfenLines(record, {
                targetSfen: params.targetSfen,
                maxMoves: params.maxMoves,
              });
            }
          } catch (error) {
            console.warn(`Failed to export kifu file: ${relativePath}`, error);
            job.status.failedFiles += 1;
          }
          if (lines) {
            for (const line of lines) {
              outputBuffer += line + "\n";
              job.status.exportedLines += 1;
              if (outputBuffer.length >= OUTPUT_BUFFER_SIZE) {
                await flush();
              }
            }
          }
          job.status.processedFiles += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (job.cancelRequested) {
          throw new ExportCancelledError();
        }
        await flush();
        stream.end();
        await finished(stream, { cleanup: true });
      },
      { overwrite: params.overwrite },
    );
    clearKifuListCache();
    finishJob(job, "completed");
  } catch (error) {
    if (error instanceof ExportCancelledError) {
      finishJob(job, "cancelled");
    } else {
      console.error("Failed to export kifu search results:", error);
      finishJob(job, "failed", "Failed to write SFEN file");
    }
  }
}

function finishJob(job: InternalJob, state: "completed" | "failed" | "cancelled", error?: string) {
  job.status.state = state;
  job.status.error = error;
  job.completedAt = Date.now();
  if (activeJobId === job.status.jobId) {
    activeJobId = undefined;
  }
}

function cleanupJobs() {
  const expiresBefore = Date.now() - COMPLETED_JOB_TTL_MS;
  for (const [jobId, job] of jobs) {
    if (job.completedAt !== undefined && job.completedAt < expiresBefore) {
      jobs.delete(jobId);
    }
  }
}

class ExportCancelledError extends Error {}

export function resetSfenExportJobsForTesting() {
  jobs.clear();
  activeJobId = undefined;
}
