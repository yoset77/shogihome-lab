import { createHash, randomUUID } from "node:crypto";
import {
  type AnalysisJobRequest,
  DEFAULT_ANALYSIS_POLL_MS,
  decodeBatchJobRequest,
} from "@/common/analysis/types";
import { t } from "@/common/i18n";
import { MAX_SNAPSHOT_NODES } from "@/common/record/snapshot";
import { HttpError } from "@/server/errors";
import { LARGE_BODY_LIMIT } from "@/server/hono";
import { InternalEngine, type ResearchEngine } from "@/server/engine/internal";
import { fetchEngineConfigs, toLanEngineInfo } from "@/server/engine/list";
import {
  engineRequirements,
  resourceRegistry,
  type ResourceLease,
} from "@/server/engine/resources";
import type { EngineConfig } from "@/server/engine/types";
import { AnalysisJob } from "./job";
import type { JobSummary } from "@/common/jobs/types";
import { BatchAnalysisJob } from "./batch";
import { BatchAnalysisFiles } from "./files";
import { KIFU_DIR } from "@/server/config";
import type { BatchAnalysisJobRequest, BatchAnalysisSource } from "@/common/analysis/batch";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_JOBS = 10;
const MAX_REQUEST_LEDGER = 10_000;
const MAX_ACTIVE_JOBS = 3;

type ManagedAnalysisJob = AnalysisJob | BatchAnalysisJob;

async function resolveEngine(id: string): Promise<EngineConfig> {
  const config = (await fetchEngineConfigs()).find((config) => config.id === id);
  if (!config || !toLanEngineInfo(config)?.type?.includes("research"))
    throw new Error("Unknown research engine");
  return config;
}

export class AnalysisJobManager {
  readonly serverInstanceId = randomUUID();
  private jobs = new Map<string, ManagedAnalysisJob>();
  private requests = new Map<string, { hash: string; jobId: string }>();
  private pending = new Map<
    string,
    { hash: string; batch: boolean; result: Promise<ManagedAnalysisJob> }
  >();
  private closed = false;

  constructor(
    private readonly createEngine: (resourceLease?: ResourceLease) => ResearchEngine = (lease) =>
      new InternalEngine(lease),
    private readonly engineResolver: (id: string) => Promise<EngineConfig> = resolveEngine,
    private readonly batchFiles = new BatchAnalysisFiles(() => KIFU_DIR),
  ) {}

  capabilities() {
    return {
      serverInstanceId: this.serverInstanceId,
      pollMs: DEFAULT_ANALYSIS_POLL_MS,
      maxInputBytes: LARGE_BODY_LIMIT,
      maxNodes: MAX_SNAPSHOT_NODES,
    };
  }

  private resolveExisting(
    entry: { hash: string; jobId: string } | undefined,
    hash: string,
    batch: boolean,
  ): AnalysisJob | BatchAnalysisJob | undefined {
    if (!entry) return undefined;
    if (entry.hash !== hash) throw new HttpError(409, t.analysisJobInvalid);
    const job = this.get(entry.jobId);
    if (batch !== job instanceof BatchAnalysisJob) throw new HttpError(409, t.analysisJobInvalid);
    return job;
  }

  private async resolveEngineSnapshot(id: string): Promise<{
    config?: EngineConfig;
    resolve: () => Promise<EngineConfig>;
  }> {
    try {
      const config = structuredClone(await this.engineResolver(id));
      return { config, resolve: async () => structuredClone(config) };
    } catch (error) {
      // Preserve startup failures as job results, without retrying resolution.
      return {
        resolve: async () => {
          throw error;
        },
      };
    }
  }

  private buildJob<T>(build: () => T, lease?: ResourceLease): T {
    try {
      return build();
    } catch (error) {
      lease?.release();
      throw error;
    }
  }

  private ensureCapacity(requestId?: string): void {
    const pending =
      this.pending.size - Number(requestId !== undefined && this.pending.has(requestId));
    const active = [...this.jobs.values()].filter((job) => job.endedAt === undefined).length;
    if (
      this.closed ||
      active + pending >= MAX_ACTIVE_JOBS ||
      this.requests.size + pending >= MAX_REQUEST_LEDGER
    ) {
      throw new HttpError(503, t.analysisJobCapacity);
    }
  }

  private async admit<T extends ManagedAnalysisJob>(
    request: AnalysisJobRequest | BatchAnalysisJobRequest,
    batch: boolean,
    build: (hash: string) => Promise<T>,
  ): Promise<T> {
    this.cleanup();
    if (request.serverInstanceId !== this.serverInstanceId)
      throw new HttpError(410, t.analysisJobExpired);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.resolveExisting(this.requests.get(request.requestId), hash, batch);
    if (existing) return existing as T;
    const pending = this.pending.get(request.requestId);
    if (pending) {
      if (hash !== pending.hash || batch !== pending.batch)
        throw new HttpError(409, t.analysisJobInvalid);
      return pending.result as Promise<T>;
    }
    this.ensureCapacity();
    // Reserve admission before discovery, sharing retries without consuming another slot.
    const result = Promise.resolve()
      .then(() => build(hash))
      .finally(() => {
        if (this.pending.get(request.requestId)?.result === result)
          this.pending.delete(request.requestId);
      });
    this.pending.set(request.requestId, { hash, batch, result });
    return result;
  }

  private register<T extends ManagedAnalysisJob>(job: T, hash: string): T {
    job.start();
    this.jobs.set(job.id, job);
    this.requests.set(job.request.requestId, { hash, jobId: job.id });
    this.pending.delete(job.request.requestId);
    void job.completion.then(() => this.cleanup());
    return job;
  }

  async create(request: AnalysisJobRequest): Promise<AnalysisJob> {
    request = structuredClone(request);
    return this.admit(request, false, async (hash) => {
      const snapshot = await this.resolveEngineSnapshot(request.options.engineId);
      this.ensureCapacity(request.requestId);
      const lease = snapshot.config
        ? resourceRegistry.acquire(...engineRequirements(snapshot.config))
        : undefined;
      return this.buildJob(
        () =>
          this.register(
            new AnalysisJob(
              randomUUID(),
              request,
              this.createEngine(lease),
              snapshot.resolve,
              lease,
            ),
            hash,
          ),
        lease,
      );
    });
  }

  prepareBatch(source: BatchAnalysisSource) {
    return this.batchFiles.prepare(source);
  }

  async createBatch(request: BatchAnalysisJobRequest): Promise<BatchAnalysisJob> {
    const decoded = decodeBatchJobRequest(request);
    if (!decoded.ok) throw new HttpError(400, t.batchAnalysisInvalid);
    const input = structuredClone(decoded.value);
    return this.admit(input, true, async (hash) => {
      const snapshot = await this.resolveEngineSnapshot(input.options.engineId);
      this.ensureCapacity(input.requestId);
      const plan = this.batchFiles.get(input.planId);
      const workerCount = Math.min(input.parallelism ?? 1, plan.files.length);
      const lease = snapshot.config
        ? resourceRegistry.acquire(
            ...engineRequirements(snapshot.config).map((requirement) => ({
              ...requirement,
              cost: requirement.cost * workerCount,
            })),
          )
        : undefined;
      return this.buildJob(() => {
        const job = this.register(
          new BatchAnalysisJob(
            randomUUID(),
            input,
            plan,
            Array.from({ length: workerCount }, () => this.createEngine(lease)),
            snapshot.resolve,
            this.batchFiles,
            lease,
          ),
          hash,
        );
        this.batchFiles.release(input.planId);
        return job;
      }, lease);
    });
  }

  get(id: string): AnalysisJob | BatchAnalysisJob {
    this.cleanup();
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(410, t.analysisJobExpired);
    return job;
  }

  list(): JobSummary[] {
    this.cleanup();
    return [...this.jobs.values()].reverse().map((job) => {
      const status = job.status();
      return {
        kind: "analysis",
        id: job.id,
        requestId: status.requestId,
        serverInstanceId: this.serverInstanceId,
        createdAt: job.createdAt,
        state: status.state,
        engines: [status.engineName || job.request.options.engineId],
        completed: status.batch?.processedFiles ?? status.completedPositions,
        total: status.batch?.totalFiles ?? status.totalPositions,
        ...(status.batch ? { batch: status.batch } : {}),
        attachment: job.attachment.status(),
      };
    });
  }

  byRequest(requestId: string): AnalysisJob | BatchAnalysisJob {
    const request = this.requests.get(requestId);
    if (!request) throw new HttpError(410, t.analysisJobExpired);
    return this.get(request.jobId);
  }

  cleanup(): void {
    const terminals = [...this.jobs.values()]
      .filter((job) => job.endedAt !== undefined)
      .sort((a, b) => a.endedAt! - b.endedAt!);
    for (const [index, job] of terminals.entries()) {
      if (Date.now() - job.endedAt! >= RETENTION_MS || index < terminals.length - MAX_TERMINAL_JOBS)
        this.jobs.delete(job.id);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.cancel();
    await Promise.all([
      Promise.allSettled([...this.pending.values()].map((pending) => pending.result)),
      Promise.all([...this.jobs.values()].map((job) => job.completion)),
    ]);
  }
}

export const analysisJobManager = new AnalysisJobManager();
const cleanupTimer = setInterval(() => analysisJobManager.cleanup(), 60_000);
cleanupTimer.unref();
