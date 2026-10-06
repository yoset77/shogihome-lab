import { createAnalysisJobsClient } from "@/renderer/api/analysis_jobs";
import { createGameSessionsClient } from "@/renderer/api/game_sessions";
import type { JobSummary } from "@/common/jobs/types";
import { ApiResponseError } from "@/renderer/api/client";

export class JobListManager {
  jobs: JobSummary[] = [];
  loading = false;
  error?: unknown;
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
  async refresh(): Promise<void> {
    if (this.loading) return;
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
      this.error = error;
      this.retryMs = Math.max(
        Math.min(30_000, this.retryMs * 2),
        error instanceof ApiResponseError ? (error.retryAfterMs ?? 0) : 0,
      );
      this.retryNotBefore = Date.now() + this.retryMs;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        if (this.running) this.timer = setTimeout(() => void this.refresh(), this.retryMs);
      }
    }
  }
}
