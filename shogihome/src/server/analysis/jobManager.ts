import { createHash, randomUUID } from "node:crypto";
import {
  type AnalysisJobRequest,
  DEFAULT_ANALYSIS_POLL_MS,
  isAnalysisTerminal,
} from "@/common/analysis/types";
import { t } from "@/common/i18n";
import { MAX_SNAPSHOT_NODES } from "@/common/record/snapshot";
import { HttpError } from "@/server/errors";
import { LARGE_BODY_LIMIT } from "@/server/hono";
import { InternalEngine, type ResearchEngine } from "@/server/engine/internal";
import { fetchEngineConfigs, toLanEngineInfo } from "@/server/engine/list";
import type { EngineConfig } from "@/server/engine/types";
import { AnalysisJob } from "./job";
import type { JobSummary } from "@/common/jobs/types";

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
  private jobs = new Map<string, AnalysisJob>();
  private requests = new Map<string, { hash: string; jobId: string }>();

  constructor(
    private readonly createEngine: () => ResearchEngine = () => new InternalEngine(),
    private readonly engineResolver: (id: string) => Promise<EngineConfig> = resolveEngine,
  ) {}

  capabilities() {
    return {
      serverInstanceId: this.serverInstanceId,
      pollMs: DEFAULT_ANALYSIS_POLL_MS,
      maxInputBytes: LARGE_BODY_LIMIT,
      maxNodes: MAX_SNAPSHOT_NODES,
    };
  }

  create(request: AnalysisJobRequest): AnalysisJob {
    this.cleanup();
    if (request.serverInstanceId !== this.serverInstanceId)
      throw new HttpError(410, t.analysisJobExpired);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const accepted = this.requests.get(request.requestId);
    if (accepted) {
      if (accepted.hash !== hash) throw new HttpError(409, t.analysisJobInvalid);
      return this.get(accepted.jobId);
    }
    if (
      [...this.jobs.values()].some((job) => !isAnalysisTerminal(job.status().state)) ||
      this.requests.size >= MAX_REQUEST_LEDGER
    ) {
      throw new HttpError(503, t.analysisJobCapacity);
    }
    const job = new AnalysisJob(
      randomUUID(),
      structuredClone(request),
      this.createEngine(),
      this.engineResolver,
    );
    this.jobs.set(job.id, job);
    this.requests.set(request.requestId, { hash, jobId: job.id });
    void job.completion.then(() => this.cleanup());
    job.start();
    return job;
  }

  get(id: string): AnalysisJob {
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
        completed: status.completedPositions,
        total: status.totalPositions,
        attachment: job.attachment.status(),
      };
    });
  }

  byRequest(requestId: string): AnalysisJob {
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
