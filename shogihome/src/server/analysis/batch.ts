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

export class BatchAnalysisJob {
  readonly attachment = new JobAttachment();
  readonly createdAt = Date.now();
  readonly request: Pick<AnalysisJobRequest, "requestId" | "serverInstanceId" | "options">;
  endedAt?: number;
  private state: AnalysisJobState = "preparing";
  private error?: AnalysisJobError;
  private current?: AnalysisJob;
  private cancelled = false;
  private launched = false;
  private saving = false;
  private config?: EngineConfig;
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
    private readonly engine: ResearchEngine,
    private readonly resolveEngine: (id: string) => Promise<EngineConfig>,
    private readonly files: BatchAnalysisFiles,
    private resourceLease?: ResourceLease,
  ) {
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
    this.checkIndex(index);
    if (!this.current) throw new HttpError(423, t.batchAnalysisPreparing);
    return this.current.source();
  }
  private checkIndex(index?: number) {
    if (index !== undefined && index !== this.progress.recordIndex)
      throw new HttpError(423, t.batchAnalysisPreparing);
  }
  result(after = 0, index?: number): AnalysisJobResult {
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
      batch: { ...this.progress },
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
    if (!this.saving) this.current?.cancel();
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
  private async run(): Promise<void> {
    const deadline = setTimeout(() => {
      this.error = "deadline";
      this.cancel();
    }, BATCH_ANALYSIS_MAX_RUNTIME_MS);
    try {
      const adapter: ResearchEngine = {
        launch: async (config, timeout, signal, lease) => {
          if (!this.launched) {
            // The batch owns one shared lease for the whole run; per-file
            // jobs have none of their own.
            await this.engine.launch(config, timeout, signal, lease ?? this.resourceLease);
            this.launched = true;
          }
        },
        setMultiPV: (value) => {
          if (!this.progress.recordIndex || !this.launched) return;
          if (!this.multiPVApplied) {
            this.engine.setMultiPV(value);
            this.multiPVApplied = true;
          }
        },
        readyNewGame: () => this.engine.readyNewGame(),
        startResearch: (position, onOutput, signal) =>
          this.engine.startResearch(position, onOutput, signal),
        // The batch owns the shared engine's lifetime, not its child jobs.
        close: async () => {},
      };
      for (const outcome of this.outcomes) {
        if (this.cancelled) break;
        this.progress.currentFile = outcome.index;
        this.progress.currentPath = outcome.path;
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
          async (id) => (this.config ??= structuredClone(await this.resolveEngine(id))),
        );
        if (!candidate.status().totalPositions) {
          this.complete(outcome, "skipped", "noPositions");
          continue;
        }
        this.current = candidate;
        this.progress.recordIndex = outcome.index;
        this.progress.recordPath = outcome.path;
        this.progress.saved = false;
        this.state = "running";
        this.current.start();
        await this.current.completion;
        if (this.cancelled) {
          outcome.state = "cancelled";
          break;
        }
        if (this.current.status().state !== "completed") {
          this.error = this.current.status().error ?? "engine";
          this.complete(outcome, "failed", "engine");
          break;
        }
        const source = structuredClone(loaded.source);
        const nodes = new Map(source.nodes.map((node) => [node.id, node]));
        for (const update of this.current.result().nodes) {
          const node = nodes.get(update.id)!;
          node.comment = update.comment;
          if (update.researchInfo)
            node.customData = { ...node.customData, researchInfo: update.researchInfo };
        }
        this.saving = true;
        try {
          await this.files.save(loaded, source, this.batchRequest.fileOptions);
          this.progress.saved = true;
          this.complete(outcome, "saved");
        } catch (error) {
          this.complete(outcome, "failed", error instanceof BatchFileError ? error.reason : "save");
        } finally {
          this.saving = false;
        }
      }
    } catch (error) {
      console.error("Batch analysis failed:", error);
      this.error ??= error instanceof HttpError ? "capacity" : "engine";
    } finally {
      if (!this.cancelled) this.state = "finishing";
      try {
        await this.engine.close();
      } catch (error) {
        console.error("Batch engine cleanup failed:", error);
        this.error ??= "engine";
      }
      this.resourceLease?.release();
      this.resourceLease = undefined;
      clearTimeout(deadline);
      this.state = this.error ? "failed" : this.cancelled ? "cancelled" : "completed";
      this.endedAt = Date.now();
      this.resolveCompletion();
    }
  }
  private multiPVApplied = false;
}
