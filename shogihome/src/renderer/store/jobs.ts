import { createAnalysisJobsClient } from "@/renderer/api/analysis_jobs";
import { createGameSessionsClient } from "@/renderer/api/game_sessions";
import type { JobSummary } from "@/common/jobs/types";
import { ApiResponseError } from "@/renderer/api/client";
import { t } from "@/common/i18n";

export class JobListManager {
  jobs: JobSummary[] = [];
  loading = false;
  error?: unknown;
  private cancelling = new Set<string>();
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private retryMs = 5000;
  private retryNotBefore = 0;
  private running = false;
  constructor(
    private readonly analysis = createAnalysisJobsClient(),
    private readonly games = createGameSessionsClient(),
  ) {}
  start(): void {
    this.running = true;
    void this.refresh();
  }
  stop(): void {
    this.running = false;
    ++this.generation;
    this.loading = false;
    clearTimeout(this.timer);
  }
  canCancel(job: JobSummary): boolean {
    return (
      job.kind === "analysis" &&
      !!job.batch?.parallel &&
      ["preparing", "running"].includes(job.state) &&
      !this.loading &&
      !this.cancelling.has(job.id) &&
      Date.now() >= this.retryNotBefore
    );
  }
  async cancel(job: JobSummary): Promise<void> {
    if (!this.canCancel(job)) return;
    this.cancelling.add(job.id);
    const generation = this.generation;
    try {
      // Parallel batches cannot be attached, so their cancellation stays unowned and idempotent.
      const status = await this.analysis.cancel(job.id);
      if (generation !== this.generation) return;
      if (status.jobId !== job.id || status.serverInstanceId !== job.serverInstanceId)
        throw new Error(t.jobsInvalid);
      this.jobs = this.jobs.map((current) =>
        current.id === job.id && current.serverInstanceId === job.serverInstanceId
          ? { ...current, state: status.state, batch: status.batch }
          : current,
      );
      this.error = undefined;
    } catch (error) {
      if (generation === this.generation) this.backoff(error);
    } finally {
      this.cancelling.delete(job.id);
      if (generation === this.generation) this.scheduleRefresh();
    }
  }
  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    if (this.running)
      this.timer = setTimeout(
        () => void this.refresh(),
        Math.max(this.retryMs, this.retryNotBefore - Date.now()),
      );
  }
  private backoff(error: unknown): void {
    this.error = error;
    this.retryMs = Math.max(
      Math.min(30_000, this.retryMs * 2),
      error instanceof ApiResponseError ? (error.retryAfterMs ?? 0) : 0,
    );
    this.retryNotBefore = Date.now() + this.retryMs;
  }
  async refresh(): Promise<void> {
    if (this.loading || this.cancelling.size) return;
    clearTimeout(this.timer);
    if (Date.now() < this.retryNotBefore) {
      if (this.running)
        this.timer = setTimeout(() => void this.refresh(), this.retryNotBefore - Date.now());
      return;
    }
    this.loading = true;
    const generation = this.generation;
    try {
      const [analysis, games] = await Promise.all([this.analysis.list(), this.games.list()]);
      if (generation !== this.generation) return;
      this.jobs = [...analysis, ...games].sort((a, b) => b.createdAt - a.createdAt);
      this.error = undefined;
      this.retryMs = 5000;
      this.retryNotBefore = 0;
    } catch (error) {
      if (generation !== this.generation) return;
      this.backoff(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.scheduleRefresh();
      }
    }
  }
}
