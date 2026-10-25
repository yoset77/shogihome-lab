import { createHash, randomUUID } from "node:crypto";
import {
  type AnalysisJobRequest,
  DEFAULT_ANALYSIS_POLL_MS,
  isAnalysisTerminal,
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

async function resolveEngine(id: string): Promise<EngineConfig> {
  const config = (await fetchEngineConfigs()).find((config) => config.id === id);
  if (!config || !toLanEngineInfo(config)?.type?.includes("research"))
    throw new Error("Unknown research engine");
  return config;
}

export class AnalysisJobManager {
  readonly serverInstanceId = randomUUID();
  private jobs = new Map<string, AnalysisJob | BatchAnalysisJob>();
  private requests = new Map<string, { hash: string; jobId: string }>();

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

  private ensureCapacity(): void {
    if (
      [...this.jobs.values()].some((job) => !isAnalysisTerminal(job.status().state)) ||
      this.requests.size >= MAX_REQUEST_LEDGER
    ) {
      throw new HttpError(503, t.analysisJobCapacity);
    }
  }

  async create(request: AnalysisJobRequest): Promise<AnalysisJob> {
    this.cleanup();
    if (request.serverInstanceId !== this.serverInstanceId)
      throw new HttpError(410, t.analysisJobExpired);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.resolveExisting(this.requests.get(request.requestId), hash, false);
    if (existing) return existing as AnalysisJob;
    this.ensureCapacity();
    // Resolve the engine outside the synchronous tail so the resource
    // reservation can be rejected at the HTTP boundary.
    const snapshot = await this.resolveEngineSnapshot(request.options.engineId);
    const reaccepted = this.resolveExisting(this.requests.get(request.requestId), hash, false);
    if (reaccepted) return reaccepted as AnalysisJob;
    this.ensureCapacity();
    const lease = snapshot.config
      ? resourceRegistry.acquire(...engineRequirements(snapshot.config))
      : undefined;
    const job = this.buildJob(() => {
      const created = new AnalysisJob(
        randomUUID(),
        structuredClone(request),
        this.createEngine(lease),
        snapshot.resolve,
        lease,
      );
      this.jobs.set(created.id, created);
      this.requests.set(request.requestId, { hash, jobId: created.id });
      void created.completion.then(() => this.cleanup());
      created.start();
      return created;
    }, lease);
    return job;
  }

  prepareBatch(source: BatchAnalysisSource) {
    return this.batchFiles.prepare(source);
  }

  async createBatch(request: BatchAnalysisJobRequest): Promise<BatchAnalysisJob> {
    const decoded = decodeBatchJobRequest(request);
    if (!decoded.ok) throw new HttpError(400, t.batchAnalysisInvalid);
    request = decoded.value;
    this.cleanup();
    if (request.serverInstanceId !== this.serverInstanceId)
      throw new HttpError(410, t.analysisJobExpired);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.resolveExisting(this.requests.get(request.requestId), hash, true);
    if (existing) return existing as BatchAnalysisJob;
    this.ensureCapacity();
    const snapshot = await this.resolveEngineSnapshot(request.options.engineId);
    const reaccepted = this.resolveExisting(this.requests.get(request.requestId), hash, true);
    if (reaccepted) return reaccepted as BatchAnalysisJob;
    this.ensureCapacity();
    const plan = this.batchFiles.get(request.planId);
    const workerCount = Math.min(request.parallelism ?? 1, plan.files.length);
    const lease = snapshot.config
      ? resourceRegistry.acquire(
          ...engineRequirements(snapshot.config).map((requirement) => ({
            ...requirement,
            cost: requirement.cost * workerCount,
          })),
        )
      : undefined;
    const batch = this.buildJob(() => {
      const created = new BatchAnalysisJob(
        randomUUID(),
        structuredClone(request),
        plan,
        Array.from({ length: workerCount }, () => this.createEngine(lease)),
        snapshot.resolve,
        this.batchFiles,
        lease,
      );
      this.jobs.set(created.id, created);
      this.requests.set(request.requestId, { hash, jobId: created.id });
      this.batchFiles.release(request.planId);
      void created.completion.then(() => this.cleanup());
      created.start();
      return created;
    }, lease);
    return batch;
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
    for (const job of this.jobs.values()) job.cancel();
    await Promise.all([...this.jobs.values()].map((job) => job.completion));
  }
}

export const analysisJobManager = new AnalysisJobManager();
const cleanupTimer = setInterval(() => analysisJobManager.cleanup(), 60_000);
cleanupTimer.unref();
