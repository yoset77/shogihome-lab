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
  private retryAfterNotBefore = 0;
  private retryAfterTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  constructor(
    private readonly analysis = createAnalysisJobsClient(),
    private readonly games = createGameSessionsClient(),
  ) {}
  start(): void {
    this.running = true;
    this.scheduleRetryAfterReset();
    void this.refresh();
  }
  stop(): void {
    this.running = false;
    ++this.generation;
    this.loading = false;
    clearTimeout(this.timer);
    clearTimeout(this.retryAfterTimer);
  }
  canCancel(job: JobSummary): boolean {
    return (
      ((job.kind === "analysis" && !!job.batch?.parallel) ||
        (job.kind === "game" && !!job.parallelGame)) &&
      ["preparing", "running"].includes(job.state) &&
      !this.loading &&
      !this.cancelling.has(job.id) &&
      Date.now() >= this.retryAfterNotBefore
    );
  }
  async cancel(job: JobSummary): Promise<void> {
    if (!this.canCancel(job)) return;
    this.cancelling.add(job.id);
    const generation = this.generation;
    try {
      // Parallel jobs cannot be attached, so their cancellation stays unowned and idempotent.
      if (job.kind === "game") {
        const status = await this.games.cancel(job.id);
        if (generation !== this.generation) return;
        if (
          status.id !== job.id ||
          status.serverInstanceId !== job.serverInstanceId ||
          !status.parallelGame
        )
          throw new Error(t.jobsInvalid);
        this.jobs = this.jobs.map((current) =>
          current.kind === "game" &&
          current.id === job.id &&
          current.serverInstanceId === job.serverInstanceId
            ? status
            : current,
        );
        this.error = undefined;
        return;
      }
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
      if (generation === this.generation) {
        this.error = error;
        this.honorRetryAfter(error);
      }
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
        Math.max(
          this.retryMs,
          Math.max(this.retryNotBefore, this.retryAfterNotBefore) - Date.now(),
        ),
      );
  }
  private honorRetryAfter(error: unknown): void {
    if (!(error instanceof ApiResponseError) || !error.retryAfterMs) return;
    this.retryAfterNotBefore = Math.max(this.retryAfterNotBefore, Date.now() + error.retryAfterMs);
    this.scheduleRetryAfterReset();
  }
  private scheduleRetryAfterReset(): void {
    clearTimeout(this.retryAfterTimer);
    const delay = this.retryAfterNotBefore - Date.now();
    // Re-enable manual cancellation even if polling is still backing off.
    if (this.running && delay > 0)
      this.retryAfterTimer = setTimeout(() => {
        this.retryAfterNotBefore = 0;
      }, delay);
  }
  private backoff(error: unknown): void {
    this.error = error;
    this.retryMs = Math.min(30_000, this.retryMs * 2);
    this.retryNotBefore = Date.now() + this.retryMs;
    this.honorRetryAfter(error);
  }
  async refresh(): Promise<void> {
    if (this.loading || this.cancelling.size) return;
    clearTimeout(this.timer);
    const retryNotBefore = Math.max(this.retryNotBefore, this.retryAfterNotBefore);
    if (Date.now() < retryNotBefore) {
      if (this.running)
        this.timer = setTimeout(() => void this.refresh(), retryNotBefore - Date.now());
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
