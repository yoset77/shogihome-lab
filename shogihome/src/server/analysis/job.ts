import { Color, Move, type Node, type Record as ShogiRecord } from "tsshogi";
import { parseUSIPV, toBlackSearchScore, type USIInfoCommand } from "@/common/game/usi";
import { getMoveAccuracyText } from "@/common/game/score";
import { getTranslationTable } from "@/common/i18n/translation_table";
import { t } from "@/common/i18n";
import { applyComment, buildSearchComment } from "@/common/record/search_comment";
import { JobAttachment } from "@/server/jobs/attachment";
import { HttpError } from "@/server/errors";
import type { JobBinding } from "@/common/jobs/types";
import {
  SearchInfoSenderType,
  type RecordCustomData,
  type SearchInfo,
} from "@/common/record/types";
import { encodeSearchInfo, restoreRecord } from "@/common/record/snapshot";
import {
  isAnalysisTerminal,
  parseAnalysisInfo,
  type AnalysisJobError,
  type AnalysisJobRequest,
  type AnalysisJobResult,
  type AnalysisJobState,
  type AnalysisJobStatus,
  type AnalysisNodeResult,
} from "@/common/analysis/types";
import type { ResearchEngine, ResearchSearch } from "@/server/engine/internal";
import type { ResourceLease } from "@/server/engine/resources";
import type { EngineConfig } from "@/server/engine/types";

export const ANALYSIS_MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
const MAX_RESULT_BYTES = 20 * 1024 * 1024;

export class AnalysisJob {
  private readonly cancellations = new Set<string>();
  cancelOutcome(requestId: string): { state: "accepted" | "unknown" } {
    return { state: this.cancellations.has(requestId) ? "accepted" : "unknown" };
  }
  cancelOwned(binding: JobBinding, requestId?: string, authorization?: JobBinding): void {
    this.attachment.authorizeOperation(binding, authorization);
    if (requestId && !this.cancellations.has(requestId) && this.cancellations.size >= 10_000)
      throw new HttpError(503, t.analysisJobCapacity);
    this.cancel();
    if (requestId) this.cancellations.add(requestId);
  }
  readonly attachment = new JobAttachment();
  readonly createdAt = Date.now();
  private state: AnalysisJobState = "preparing";
  private error?: AnalysisJobError;
  private record: ShogiRecord;
  private nodes: Map<string, Node>;
  private targets: string[];
  private completedPositions = 0;
  private resultRevision = 0;
  private results = new Map<string, AnalysisNodeResult>();
  private resultSizes = new Map<string, number>();
  private resultBytes = 0;
  private controller = new AbortController();
  private engineName = "";
  private current: AnalysisJobStatus["current"] = null;
  private infos = new Map<number, USIInfoCommand>();
  private lastSearchInfo?: SearchInfo;
  private searchInfo?: SearchInfo;
  private search?: ResearchSearch;
  private resolveCompletion!: () => void;
  readonly completion = new Promise<void>((resolve) => {
    this.resolveCompletion = resolve;
  });
  endedAt?: number;

  constructor(
    readonly id: string,
    readonly request: AnalysisJobRequest,
    private readonly engine: ResearchEngine,
    private readonly resolveEngine: (id: string) => Promise<EngineConfig>,
    private resourceLease?: ResourceLease,
  ) {
    const restored = restoreRecord(request.source);
    this.record = restored.record;
    this.nodes = restored.nodes;
    const options = request.options;
    const start = options.startCriteria.enableNumber ? options.startCriteria.number - 1 : 0;
    const end = options.endCriteria.enableNumber
      ? options.endCriteria.number
      : Number.MAX_SAFE_INTEGER;
    this.targets = request.source.selectedPath.filter((id) => {
      const node = this.nodes.get(id)!;
      return (
        node.ply >= start &&
        node.ply <= end &&
        (node.move instanceof Move || (node === this.record.first && node.next !== null))
      );
    });
    if (options.descending) this.targets.reverse();
  }

  start(): void {
    queueMicrotask(() => {
      void this.run();
    });
  }

  source() {
    return this.request.source;
  }

  status(): AnalysisJobStatus {
    return {
      jobId: this.id,
      requestId: this.request.requestId,
      serverInstanceId: this.request.serverInstanceId,
      state: this.state,
      engineName: this.engineName,
      completedPositions: this.completedPositions,
      totalPositions: this.targets.length,
      resultRevision: this.resultRevision,
      attachment: this.attachment.status(),
      current: this.current && { ...this.current, infos: [...this.infos.values()] },
      ...(this.error ? { error: this.error } : {}),
    };
  }

  result(afterRevision = 0): AnalysisJobResult {
    return {
      attachment: this.attachment.status(),
      jobId: this.id,
      serverInstanceId: this.request.serverInstanceId,
      revision: this.resultRevision,
      nodes: [...this.results.values()].filter((result) => result.revision > afterRevision),
    };
  }

  cancel(): void {
    if (isAnalysisTerminal(this.state) || this.state === "finishing") return;
    this.state = "cancelling";
    this.controller.abort();
  }

  private saveResult(id: string): void {
    const node = this.nodes.get(id)!;
    const info = (node.customData as RecordCustomData | undefined)?.researchInfo;
    const entry: AnalysisNodeResult = {
      id,
      revision: this.resultRevision + 1,
      comment: node.comment,
      ...(info ? { researchInfo: encodeSearchInfo(info) } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (
      node.comment.length > 65_536 ||
      this.resultBytes - (this.resultSizes.get(id) ?? 0) + size > MAX_RESULT_BYTES
    ) {
      this.error = "capacity";
      this.controller.abort();
      return;
    }
    this.resultRevision++;
    this.resultBytes += size - (this.resultSizes.get(id) ?? 0);
    this.resultSizes.set(id, size);
    this.results.set(id, entry);
  }

  private onOutput(id: string, searchId: number, line: string): void {
    if (
      this.controller.signal.aborted ||
      (this.state !== "running" && this.state !== "preparing") ||
      this.current?.searchId !== searchId
    )
      return;
    const parsed = parseAnalysisInfo(line);
    if (!parsed) return;
    const multipv = parsed.multipv ?? 1;
    const merged = { ...this.infos.get(multipv), ...parsed, multipv };
    if (parsed.scoreCP !== undefined || parsed.scoreMate !== undefined) {
      merged.scoreCP = parsed.scoreCP;
      merged.scoreMate = parsed.scoreMate;
      merged.lowerbound = parsed.lowerbound;
      merged.upperbound = parsed.upperbound;
    }
    this.infos.set(multipv, merged);
    if (multipv !== 1) return;
    if (
      merged.depth === undefined &&
      merged.nodes === undefined &&
      merged.scoreCP === undefined &&
      merged.scoreMate === undefined &&
      !merged.pv?.length
    )
      return;
    const pv = merged.pv && parseUSIPV(this.record.position, merged.pv);
    const info: SearchInfo = {
      depth: merged.depth,
      nodes: merged.nodes,
      ...toBlackSearchScore(merged, this.record.position.color),
      pv,
    };
    this.searchInfo = info;
    const node = this.nodes.get(id)!;
    const data = (node.customData ?? {}) as RecordCustomData;
    if ((info.depth ?? 0) >= (data.researchInfo?.depth ?? 0)) {
      node.customData = { ...data, researchInfo: info };
      this.saveResult(id);
    }
  }

  private annotate(index: number): void {
    if (!this.lastSearchInfo || !this.searchInfo) return;
    const options = this.request.options;
    const before = options.descending ? this.searchInfo : this.lastSearchInfo;
    const after = options.descending ? this.lastSearchInfo : this.searchInfo;
    const id = this.targets[options.descending ? index - 1 : index];
    const target = this.nodes.get(id)!;
    if (!(target.move instanceof Move)) return;
    this.record.gotoNode(target);
    let header = "";
    const isBestMove = before.pv?.[0] && target.move.equals(before.pv[0]);
    if (!isBestMove && before.score !== undefined && after.score !== undefined) {
      const sign = target.move.color === Color.BLACK ? 1 : -1;
      const accuracy = getMoveAccuracyText(
        before.score * sign,
        after.score * sign,
        options.accuracy,
        getTranslationTable(options.language),
      );
      if (accuracy) header = `【${accuracy}】`;
    }
    const add = buildSearchComment(
      this.record.position,
      SearchInfoSenderType.RESEARCHER,
      options.commentFormat,
      after,
      { header, engineName: this.engineName },
    );
    target.comment = applyComment(target.comment, add, options.commentBehavior);
    this.saveResult(id);
  }

  private waitForBudget(search: ResearchSearch): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("Analysis cancelled"));
      const timer = setTimeout(
        () => finish(),
        this.request.options.perMoveCriteria.maxSeconds * 1000,
      );
      this.controller.signal.addEventListener("abort", abort, { once: true });
      void search.finished.then(() => finish(), finish);
      if (this.controller.signal.aborted) abort();
    });
  }

  private async run(): Promise<void> {
    const deadline = setTimeout(() => {
      this.error = "deadline";
      this.controller.abort();
    }, ANALYSIS_MAX_RUNTIME_MS);
    try {
      const config = await this.resolveEngine(this.request.options.engineId);
      if (this.controller.signal.aborted) throw new Error("Analysis cancelled");
      this.engineName = config.name;
      await this.engine.launch(
        config,
        this.request.options.engineTimeoutSeconds,
        this.controller.signal,
        this.resourceLease,
      );
      if (this.controller.signal.aborted) throw new Error("Analysis cancelled");
      if (this.request.options.overrideMultiPV)
        this.engine.setMultiPV(this.request.options.multiPV);
      this.engine.readyNewGame();
      for (let index = 0; index < this.targets.length; index++) {
        if (this.controller.signal.aborted) throw new Error("Analysis cancelled");
        const id = this.targets[index];
        this.record.gotoNode(this.nodes.get(id)!);
        this.lastSearchInfo = this.searchInfo;
        this.searchInfo = undefined;
        this.infos.clear();
        const searchId = index + 1;
        const position = this.record.usi;
        this.current = { nodeId: id, searchId, position, infos: [] };
        this.search = await this.engine.startResearch(
          position,
          (line) => this.onOutput(id, searchId, line),
          this.controller.signal,
        );
        if (this.controller.signal.aborted) throw new Error("Analysis cancelled");
        this.state = "running";
        await this.waitForBudget(this.search);
        await this.search.stop();
        if (this.controller.signal.aborted) throw new Error("Analysis cancelled");
        this.annotate(index);
        this.completedPositions++;
        this.search = undefined;
      }
      this.state = "finishing";
    } catch (error) {
      if (!this.controller.signal.aborted) {
        console.error(`Analysis job ${this.id} failed:`, error);
        this.error = error instanceof HttpError && error.status === 503 ? "capacity" : "engine";
        this.state = "finishing";
      }
    } finally {
      if (this.controller.signal.aborted && this.search) {
        try {
          await this.search.cancel();
        } catch (error) {
          console.error("Analysis cancellation failed:", error);
          this.error ??= "engine";
        }
      }
      try {
        await this.engine.close();
      } catch (error) {
        console.error("Analysis cleanup failed:", error);
        this.error ??= "engine";
      }
      this.resourceLease?.release();
      this.resourceLease = undefined;
      clearTimeout(deadline);
      this.state = this.error
        ? "failed"
        : this.controller.signal.aborted
          ? "cancelled"
          : "completed";
      this.endedAt = Date.now();
      this.resolveCompletion();
    }
  }
}
