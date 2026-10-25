import type { RecordCustomData } from "@/common/record/types";
import type {
  BatchAnalysisJobRequest,
  BatchAnalysisPlan,
  BatchFileResult,
  BatchAnalysisProgress,
} from "@/common/analysis/batch";
import type {
  AnalysisJobRequest,
  AnalysisJobStatus,
  AnalysisJobResult,
  AnalysisJobError,
  AnalysisJobState,
} from "@/common/analysis/types";
import type { ResearchEngine } from "@/server/engine/internal";
import type { ResourceLease } from "@/server/engine/resources";
import type { EngineConfig } from "@/server/engine/types";
import { JobAttachment } from "@/server/jobs/attachment";
import type { JobBinding } from "@/common/jobs/types";
import { HttpError } from "@/server/errors";
import { t } from "@/common/i18n";
import { AnalysisJob } from "./job";
import { BatchAnalysisFiles, BatchFileError } from "./files";

export const BATCH_ANALYSIS_MAX_RUNTIME_MS = 14 * 24 * 60 * 60 * 1000;

type Worker = {
  engine: ResearchEngine;
  current?: AnalysisJob;
  outcome?: BatchFileResult;
  launched: boolean;
  multiPVApplied: boolean;
  saving: boolean;
};

export class BatchAnalysisJob {
  readonly attachment = new JobAttachment();
  readonly createdAt = Date.now();
  readonly request: Pick<AnalysisJobRequest, "requestId" | "serverInstanceId" | "options">;
  endedAt?: number;
  private state: AnalysisJobState = "preparing";
  private error?: AnalysisJobError;
  private current?: AnalysisJob;
  private cancelled = false;
  private config?: EngineConfig;
  private configPromise?: Promise<EngineConfig>;
  private workers: Worker[];
  private nextFile = 0;
  private cancellations = new Set<string>();
  private progress: BatchAnalysisProgress;
  private outcomes: BatchFileResult[];
  private resolveCompletion!: () => void;
  readonly completion = new Promise<void>((resolve) => {
    this.resolveCompletion = resolve;
  });
  constructor(
    readonly id: string,
    readonly batchRequest: BatchAnalysisJobRequest,
    plan: BatchAnalysisPlan,
    engines: readonly ResearchEngine[],
    private readonly resolveEngine: (id: string) => Promise<EngineConfig>,
    private readonly files: BatchAnalysisFiles,
    private resourceLease?: ResourceLease,
  ) {
    this.workers = engines.map((engine) => ({
      engine,
      launched: false,
      multiPVApplied: false,
      saving: false,
    }));
    this.request = {
      requestId: batchRequest.requestId,
      serverInstanceId: batchRequest.serverInstanceId,
      options: batchRequest.options,
    };
    this.outcomes = plan.files.map((path, index) => ({ path, index: index + 1, state: "pending" }));
    this.progress = {
      totalFiles: plan.files.length,
      processedFiles: 0,
      currentFile: 0,
      currentPath: "",
      recordIndex: 0,
      recordPath: "",
      saved: false,
      successTotal: 0,
      failedTotal: 0,
      skippedTotal: 0,
    };
  }
  start(): void {
    queueMicrotask(() => {
      void this.run();
    });
  }
  source(index?: number) {
    this.ensureAttachable();
    this.checkIndex(index);
    if (!this.current) throw new HttpError(423, t.batchAnalysisPreparing);
    return this.current.source();
  }
  private checkIndex(index?: number) {
    if (index !== undefined && index !== this.progress.recordIndex)
      throw new HttpError(423, t.batchAnalysisPreparing);
  }
  result(after = 0, index?: number): AnalysisJobResult {
    this.ensureAttachable();
    this.checkIndex(index);
    const result = this.current?.result(after) ?? {
      jobId: this.id,
      serverInstanceId: this.request.serverInstanceId,
      revision: 0,
      nodes: [],
    };
    return {
      ...result,
      attachment: this.attachment.status(),
      recordIndex: this.progress.recordIndex,
    };
  }
  fileResults(): BatchFileResult[] {
    return structuredClone(this.outcomes);
  }
  status(): AnalysisJobStatus {
    const current = this.current?.status();
    return {
      jobId: this.id,
      requestId: this.request.requestId,
      serverInstanceId: this.request.serverInstanceId,
      state: this.state === "running" && current?.state === "preparing" ? "preparing" : this.state,
      engineName: this.config?.name ?? "",
      completedPositions: current?.completedPositions ?? 0,
      totalPositions: current?.totalPositions ?? 0,
      resultRevision: current?.resultRevision ?? 0,
      current: current?.current ?? null,
      attachment: this.attachment.status(),
      batch: {
        ...this.progress,
        ...(this.backgroundOnly
          ? {
              parallel: {
                parallelism: this.batchRequest.parallelism!,
                activeFiles: this.workers.filter((worker) => worker.outcome?.state === "running")
                  .length,
              },
            }
          : {}),
      },
      ...(this.error ? { error: this.error } : {}),
    };
  }
  cancelOutcome(requestId: string) {
    return {
      state: this.cancellations.has(requestId) ? ("accepted" as const) : ("unknown" as const),
    };
  }
  cancelOwned(binding: JobBinding, requestId?: string, authorization?: JobBinding): void {
    this.attachment.authorizeOperation(binding, authorization);
    if (requestId && !this.cancellations.has(requestId) && this.cancellations.size >= 10_000)
      throw new HttpError(503, t.analysisJobCapacity);
    this.cancel();
    if (requestId) this.cancellations.add(requestId);
  }
  cancel(): void {
    if (this.endedAt !== undefined || this.state === "finishing") return;
    this.cancelled = true;
    this.state = "cancelling";
    for (const worker of this.workers) {
      if (!worker.saving) worker.current?.cancel();
    }
  }
  get backgroundOnly(): boolean {
    return (this.batchRequest.parallelism ?? 1) > 1;
  }
  ensureAttachable(): void {
    if (this.backgroundOnly) throw new HttpError(409, t.batchAnalysisBackgroundOnly);
  }
  private complete(
    outcome: BatchFileResult,
    state: "saved" | "failed" | "skipped",
    reason?: BatchFileResult["reason"],
  ) {
    outcome.state = state;
    outcome.reason = reason;
    this.progress.processedFiles++;
    this.progress[
      state === "saved" ? "successTotal" : state === "failed" ? "failedTotal" : "skippedTotal"
    ]++;
  }
  private async runWorker(worker: Worker): Promise<void> {
    const engine = worker.engine;
    try {
      const adapter: ResearchEngine = {
        launch: async (config, timeout, signal, lease) => {
          if (!worker.launched) {
            // The parent owns the lease and every worker's engine lifetime.
            await engine.launch(config, timeout, signal, lease ?? this.resourceLease);
            worker.launched = true;
          }
        },
        setMultiPV: (value) => {
          if (worker.launched && !worker.multiPVApplied) {
            engine.setMultiPV(value);
            worker.multiPVApplied = true;
          }
        },
        readyNewGame: () => engine.readyNewGame(),
        startResearch: (position, onOutput, signal) =>
          engine.startResearch(position, onOutput, signal),
        close: async () => {},
      };
      while (!this.cancelled) {
        // Claim synchronously so no two workers can process the same file.
        const outcome = this.outcomes[this.nextFile++];
        if (!outcome) break;
        worker.outcome = outcome;
        if (!this.backgroundOnly) {
          this.progress.currentFile = outcome.index;
          this.progress.currentPath = outcome.path;
        }
        outcome.state = "running";
        let loaded;
        try {
          loaded = await this.files.load(outcome.path, this.batchRequest.fileOptions.autoDetect);
        } catch (error) {
          this.complete(outcome, "failed", error instanceof BatchFileError ? error.reason : "read");
          continue;
        }
        if (this.cancelled) {
          outcome.state = "cancelled";
          break;
        }
        if (
          this.batchRequest.skipAnalyzed &&
          loaded.source.nodes.some(
            (node) =>
              node.parentId !== null &&
              !!(node.customData as RecordCustomData | null)?.researchInfo,
          )
        ) {
          this.complete(outcome, "skipped", "analyzed");
          continue;
        }
        const candidate = new AnalysisJob(
          this.id,
          { ...this.request, source: loaded.source },
          adapter,
          (id) =>
            (this.configPromise ??= this.resolveEngine(id).then(
              (config) => (this.config = structuredClone(config)),
            )),
        );
        if (!candidate.status().totalPositions) {
          this.complete(outcome, "skipped", "noPositions");
          continue;
        }
        worker.current = candidate;
        if (!this.backgroundOnly) {
          this.current = candidate;
          this.progress.recordIndex = outcome.index;
          this.progress.recordPath = outcome.path;
          this.progress.saved = false;
        }
        this.state = "running";
        candidate.start();
        await candidate.completion;
        if (this.cancelled) {
          outcome.state = "cancelled";
          break;
        }
        if (candidate.status().state !== "completed") {
          this.error ??= candidate.status().error ?? "engine";
          this.complete(outcome, "failed", "engine");
          this.cancel();
          break;
        }
        const source = structuredClone(loaded.source);
        const nodes = new Map(source.nodes.map((node) => [node.id, node]));
        for (const update of candidate.result().nodes) {
          const node = nodes.get(update.id)!;
          node.comment = update.comment;
          if (update.researchInfo)
            node.customData = { ...node.customData, researchInfo: update.researchInfo };
        }
        worker.saving = true;
        try {
          await this.files.save(loaded, source, this.batchRequest.fileOptions);
          if (!this.backgroundOnly) this.progress.saved = true;
          this.complete(outcome, "saved");
        } catch (error) {
          this.complete(outcome, "failed", error instanceof BatchFileError ? error.reason : "save");
        } finally {
          worker.saving = false;
          worker.current = undefined;
        }
      }
    } catch (error) {
      console.error("Batch analysis failed:", error);
      this.error ??= error instanceof HttpError && error.status === 503 ? "capacity" : "engine";
      if (worker.outcome?.state === "running") this.complete(worker.outcome, "failed", "engine");
      this.cancel();
    } finally {
      worker.current = undefined;
      worker.outcome = undefined;
    }
  }
  private async run(): Promise<void> {
    const deadline = setTimeout(() => {
      this.error ??= "deadline";
      this.cancel();
    }, BATCH_ANALYSIS_MAX_RUNTIME_MS);
    try {
      await Promise.allSettled(this.workers.map((worker) => this.runWorker(worker)));
    } finally {
      if (!this.cancelled) this.state = "finishing";
      const cleanup = await Promise.allSettled(
        this.workers.map(async (worker) => worker.engine.close()),
      );
      for (const result of cleanup) {
        if (result.status === "rejected") {
          console.error("Batch engine cleanup failed:", result.reason);
          this.error ??= "engine";
        }
      }
      this.resourceLease?.release();
      this.resourceLease = undefined;
      clearTimeout(deadline);
      this.state = this.error ? "failed" : this.cancelled ? "cancelled" : "completed";
      this.endedAt = Date.now();
      this.resolveCompletion();
    }
  }
}
