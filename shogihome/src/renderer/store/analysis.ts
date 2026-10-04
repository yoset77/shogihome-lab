import { Record as ShogiRecord, type ImmutableNode } from "tsshogi";
import {
  DEFAULT_ANALYSIS_POLL_MS,
  decodeAnalysisJobRequest,
  isAnalysisTerminal,
  type AnalysisJobRequest,
  type AnalysisJobStatus,
} from "@/common/analysis/types";
import { identifier, object } from "@/common/analysis/validation";
import { analysisTexts } from "@/common/i18n/analysis";
import {
  recordContent,
  snapshotRecord,
  indexRecordNodes,
  type RecordSnapshot,
} from "@/common/record/snapshot";
import type { AnalysisSettings } from "@/common/settings/analysis";
import { normalizeSfen } from "@/common/usi/sfen";
import { createAnalysisJobsClient, type AnalysisJobsClient } from "@/renderer/api/analysis_jobs";
import { ApiResponseError, isRequestTimeoutError } from "@/renderer/api/client";
import { generateSessionId } from "@/renderer/helpers/unique";
import {
  dispatchUSIInfoUpdate,
  triggerOnStartSearch,
  setInfoSessionActive,
} from "@/renderer/players/usi_events";
import { RecordManager } from "./record";
import { useAppSettings } from "./settings";
import { clearURLParams, flushRecordForWebApp } from "./webapp";

const STORAGE_KEY = "shogihome-analysis-job";
const MONITOR_SESSION_ID = 200100;
const MAX_TIMER_MS = 2 ** 31 - 1;
type Reference = {
  requestId: string;
  serverInstanceId: string;
  jobId?: string;
  cancelRequested?: boolean;
};
type FinishCallback = (status?: AnalysisJobStatus) => void;
type ErrorCallback = (error: unknown) => void;
type StatusCallback = (status: AnalysisJobStatus | null) => void;

function loadReference(): Reference | undefined {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return;
    const value = object(JSON.parse(data));
    return {
      requestId: identifier(value.requestId),
      serverInstanceId: identifier(value.serverInstanceId),
      ...(value.jobId === undefined ? {} : { jobId: identifier(value.jobId) }),
      cancelRequested: value.cancelRequested === true,
    };
  } catch {
    return;
  }
}

export class AnalysisManager {
  private reference = loadReference();
  private pendingRequest?: AnalysisJobRequest;
  private active = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private recovering = false;
  private needsRecovery = false;
  private pollMs = DEFAULT_ANALYSIS_POLL_MS;
  private retryMs = this.pollMs;
  private retryNotBefore = 0;
  private revision = 0;
  private _status?: AnalysisJobStatus;
  private _reconnecting = false;
  private nodeIndex = new Map<string, ImmutableNode>();
  private lastNavigationRevision = 0;
  private following = true;
  private lastSearchId = 0;
  private onFinish: FinishCallback = () => {};
  private onError: ErrorCallback = () => {};
  private onStatus: StatusCallback = () => {};

  constructor(
    private recordManager: RecordManager,
    private client: AnalysisJobsClient = createAnalysisJobsClient(),
  ) {}

  on(event: "finish", handler: FinishCallback): this;
  on(event: "error", handler: ErrorCallback): this;
  on(event: "status", handler: StatusCallback): this;
  on(event: string, handler: FinishCallback | ErrorCallback | StatusCallback): this {
    if (event === "finish") this.onFinish = handler as FinishCallback;
    if (event === "error") this.onError = handler as ErrorCallback;
    if (event === "status") this.onStatus = handler as StatusCallback;
    return this;
  }

  get isActive(): boolean {
    return this.active;
  }
  get status(): AnalysisJobStatus | undefined {
    return this._status;
  }
  get reconnecting(): boolean {
    return this._reconnecting;
  }
  get hasRetainedJob(): boolean {
    return !!this.reference;
  }
  get isCancelling(): boolean {
    return !!this.reference?.cancelRequested || this._status?.state === "cancelling";
  }

  private persist(): void {
    if (this.reference) localStorage.setItem(STORAGE_KEY, JSON.stringify(this.reference));
    else localStorage.removeItem(STORAGE_KEY);
  }

  private bind(token: string): RecordSnapshot {
    ++this.generation;
    const source = this.recordManager.beginAnalysis(token);
    this.nodeIndex = indexRecordNodes(this.recordManager.record);
    this.lastNavigationRevision = this.recordManager.navigationRevision;
    this.following = true;
    this.lastSearchId = 0;
    this.revision = 0;
    this.active = true;
    this._status = undefined;
    this._reconnecting = false;
    setInfoSessionActive(MONITOR_SESSION_ID, true);
    this.onStatus(null);
    return source;
  }

  async start(settings: AnalysisSettings): Promise<void> {
    if (this.reference || this.active)
      throw new Error(analysisTexts(useAppSettings().language).capacity);
    if (
      !settings.usi ||
      (settings.usi.uri !== "lan-engine" && !settings.usi.uri.startsWith("lan-engine:"))
    )
      throw new Error(analysisTexts(useAppSettings().language).invalid);
    const requestId = generateSessionId();
    const source = this.bind(requestId);
    try {
      const app = useAppSettings();
      const options = { ...settings };
      delete options.usi;
      const input: AnalysisJobRequest = {
        requestId,
        serverInstanceId: "pending",
        source,
        options: {
          ...options,
          engineId:
            settings.usi.uri === "lan-engine"
              ? "research"
              : settings.usi.uri.substring("lan-engine:".length),
          engineTimeoutSeconds: app.engineTimeoutSeconds,
          commentFormat: app.searchCommentFormat,
          language: app.language,
          accuracy: {
            coefficientInSigmoid: app.coefficientInSigmoid,
            badMoveLevelThreshold1: app.badMoveLevelThreshold1,
            badMoveLevelThreshold2: app.badMoveLevelThreshold2,
            badMoveLevelThreshold3: app.badMoveLevelThreshold3,
            badMoveLevelThreshold4: app.badMoveLevelThreshold4,
          },
        },
      };
      const decoded = decodeAnalysisJobRequest(JSON.parse(JSON.stringify(input)));
      if (!decoded.ok) throw new Error(analysisTexts(app.language).invalid);
      const request = decoded.value;
      const capabilities = await this.client.capabilities();
      request.serverInstanceId = capabilities.serverInstanceId;
      if (new TextEncoder().encode(JSON.stringify(request)).length > capabilities.maxInputBytes)
        throw new Error(analysisTexts(app.language).capacity);
      this.reference = { requestId, serverInstanceId: capabilities.serverInstanceId };
      this.pendingRequest = request;
      this.persist();
      this.pollMs = capabilities.pollMs;
      this.resetRetry();
      try {
        this.acceptStatus(await this.client.create(request));
        this.pendingRequest = undefined;
      } catch (error) {
        if (!this.isTransient(error) || (error instanceof ApiResponseError && error.status === 503))
          throw error;
        this.backoff(error);
      }
      this.schedule();
    } catch (error) {
      const rejected =
        error instanceof ApiResponseError && [400, 409, 410, 413, 503].includes(error.status);
      this.release(requestId, !this.reference || rejected);
      throw error;
    }
  }

  async resume(confirmRecovery: () => Promise<boolean>): Promise<boolean> {
    const ref = this.reference;
    if (!ref || this.active || this.recovering) return false;
    this.bind(ref.requestId);
    this.needsRecovery = true;
    return this.recover(confirmRecovery);
  }

  private async recover(confirmRecovery: () => Promise<boolean>): Promise<boolean> {
    const ref = this.reference;
    if (!ref || !this.active || this.recovering) return false;
    if (Date.now() < this.retryNotBefore) {
      this.scheduleRecovery(confirmRecovery);
      return false;
    }
    this.recovering = true;
    try {
      const capabilities = await this.client.capabilities();
      if (capabilities.serverInstanceId !== ref.serverInstanceId)
        throw new ApiResponseError(410, analysisTexts(useAppSettings().language).expired);
      this.pollMs = capabilities.pollMs;
      if (!this._reconnecting) this.retryMs = this.pollMs;
      let status = ref.jobId
        ? await this.client.status(ref.jobId)
        : await this.client.byRequest(ref.requestId);
      this.checkStatus(status);
      ref.jobId = status.jobId;
      this.persist();
      if (ref.cancelRequested && !isAnalysisTerminal(status.state))
        status = await this.client.cancel(status.jobId);
      this.checkStatus(status);
      this.onStatus(status);
      const source = await this.client.source(status.jobId);
      const result = await this.client.result(status.jobId, 0);
      this.checkResult(result.jobId, result.serverInstanceId, status.jobId);
      if (result.revision < status.resultRevision)
        throw new Error(analysisTexts(useAppSettings().language).invalid);
      const projected = structuredClone(source);
      for (const update of result.nodes) {
        const node = projected.nodes.find((node) => node.id === update.id);
        if (!node) throw new Error(analysisTexts(useAppSettings().language).invalid);
        node.comment = update.comment;
        if (update.researchInfo)
          node.customData = { ...node.customData, researchInfo: update.researchInfo };
      }
      const local = recordContent(snapshotRecord(this.recordManager.record));
      if (local !== recordContent(source) && local !== recordContent(projected)) {
        if (!(await confirmRecovery())) {
          this.release(ref.requestId, false);
          return false;
        }
        this.recordManager.endAnalysis(ref.requestId);
        await this.recordManager.openAnalysisSnapshot(source);
        this.bind(ref.requestId);
      }
      if (!this.recordManager.applyAnalysisResults(ref.requestId, result.nodes))
        throw new Error(analysisTexts(useAppSettings().language).invalid);
      this.revision = result.revision;
      this.needsRecovery = false;
      this.resetRetry();
      this.acceptStatus(status);
      if (isAnalysisTerminal(status.state)) this.finish(status);
      else this.schedule();
      return true;
    } catch (error) {
      if (this.isTransient(error)) {
        this.backoff(error);
        this.scheduleRecovery(confirmRecovery);
        return false;
      } else {
        this.release(ref.requestId, error instanceof ApiResponseError && error.status === 410);
      }
      throw error;
    } finally {
      this.recovering = false;
    }
  }

  close(): void {
    if (!this.active || !this.reference) return;
    this.reference.cancelRequested = true;
    this.persist();
    if (
      !this.polling &&
      !this.recovering &&
      !this.needsRecovery &&
      Date.now() >= this.retryNotBefore
    ) {
      clearTimeout(this.timer);
      void this.synchronize();
    }
  }

  private checkStatus(status: AnalysisJobStatus): void {
    if (
      !this.reference ||
      status.serverInstanceId !== this.reference.serverInstanceId ||
      status.requestId !== this.reference.requestId ||
      (this.reference.jobId && status.jobId !== this.reference.jobId)
    )
      throw new Error(analysisTexts(useAppSettings().language).invalid);
  }

  private checkResult(
    jobId: string,
    serverInstanceId: string,
    expectedJobId = this.reference?.jobId,
  ): void {
    if (
      !this.reference ||
      serverInstanceId !== this.reference.serverInstanceId ||
      jobId !== expectedJobId
    ) {
      throw new Error(analysisTexts(useAppSettings().language).invalid);
    }
  }

  private acceptStatus(status: AnalysisJobStatus): void {
    this.checkStatus(status);
    this.reference!.jobId = status.jobId;
    this.persist();
    this._status = status;
    this.onStatus(status);
    const current = status.current;
    if (!current) return;
    const record = ShogiRecord.newByUSI(current.position);
    if (record instanceof Error) throw record;
    if (this.recordManager.navigationRevision !== this.lastNavigationRevision)
      this.following = false;
    const node = this.nodeIndex.get(current.nodeId);
    if (!node || normalizeSfen(node.sfen) !== normalizeSfen(record.position.sfen))
      throw new Error(analysisTexts(useAppSettings().language).invalid);
    if (this.following) {
      this.recordManager.changeNode(node);
      this.lastNavigationRevision = this.recordManager.navigationRevision;
    }
    if (current.searchId !== this.lastSearchId) {
      triggerOnStartSearch(MONITOR_SESSION_ID, record.position);
      this.lastSearchId = current.searchId;
    }
    for (const info of current.infos)
      dispatchUSIInfoUpdate(MONITOR_SESSION_ID, record.position, status.engineName, info);
  }

  private schedule(): void {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.synchronize();
    }, this.retryDelay());
  }

  private scheduleRecovery(confirmRecovery: () => Promise<boolean>): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.recover(confirmRecovery).catch((error) => this.onError(error));
    }, this.retryDelay());
  }

  private resetRetry(): void {
    this._reconnecting = false;
    this.retryMs = this.pollMs;
    this.retryNotBefore = 0;
  }

  private backoff(error: unknown): void {
    this._reconnecting = true;
    this.retryMs = Math.min(Math.max(this.retryMs, this.pollMs) * 2, Math.max(this.pollMs, 10_000));
    if (error instanceof ApiResponseError && error.status === 429)
      this.retryNotBefore = Date.now() + Math.max(error.retryAfterMs ?? 0, this.retryMs);
  }

  private retryDelay(): number {
    return Math.min(MAX_TIMER_MS, Math.max(this.retryMs, this.retryNotBefore - Date.now()));
  }

  private isTransient(error: unknown): boolean {
    return (
      error instanceof TypeError ||
      isRequestTimeoutError(error) ||
      (error instanceof ApiResponseError && (error.status === 429 || error.status >= 500))
    );
  }

  private async synchronize(): Promise<void> {
    const ref = this.reference;
    if (!ref || !this.active || this.polling || this.recovering || this.needsRecovery) return;
    if (Date.now() < this.retryNotBefore) {
      this.schedule();
      return;
    }
    const generation = this.generation;
    this.polling = true;
    try {
      let status: AnalysisJobStatus;
      try {
        status = ref.jobId
          ? await this.client.status(ref.jobId)
          : await this.client.byRequest(ref.requestId);
      } catch (error) {
        if (!(error instanceof ApiResponseError && error.status === 410 && this.pendingRequest))
          throw error;
        status = await this.client.create(this.pendingRequest);
      }
      if (generation !== this.generation) return;
      this.checkStatus(status);
      ref.jobId = status.jobId;
      this.pendingRequest = undefined;
      if (ref.cancelRequested && !isAnalysisTerminal(status.state))
        status = await this.client.cancel(status.jobId);
      if (generation !== this.generation) return;
      this.checkStatus(status);
      if (status.resultRevision > this.revision) {
        const result = await this.client.result(status.jobId, this.revision);
        if (generation !== this.generation) return;
        this.checkResult(result.jobId, result.serverInstanceId);
        if (
          result.revision < status.resultRevision ||
          result.revision < this.revision ||
          !this.recordManager.applyAnalysisResults(ref.requestId, result.nodes)
        )
          throw new Error(analysisTexts(useAppSettings().language).invalid);
        this.revision = result.revision;
      }
      this.resetRetry();
      this.acceptStatus(status);
      if (isAnalysisTerminal(status.state)) this.finish(status);
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.isTransient(error)) {
        this.backoff(error);
      } else {
        this.release(ref.requestId, error instanceof ApiResponseError && error.status === 410);
        this.onError(
          error instanceof ApiResponseError && error.status === 410
            ? new Error(analysisTexts(useAppSettings().language).expired)
            : error,
        );
      }
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  private finish(status: AnalysisJobStatus): void {
    // Keep the job linkage if browser record persistence fails.
    if (this.revision > 0) clearURLParams();
    flushRecordForWebApp(this.recordManager.record);
    this.release(status.requestId, true);
    if (status.error)
      this.onError(new Error(analysisTexts(useAppSettings().language)[status.error]));
    this.onFinish(status);
  }

  private release(token: string, forget: boolean): void {
    ++this.generation;
    clearTimeout(this.timer);
    this.active = false;
    this.needsRecovery = false;
    this.recordManager.endAnalysis(token);
    setInfoSessionActive(MONITOR_SESSION_ID, false);
    if (forget) {
      this.reference = undefined;
      this.pendingRequest = undefined;
      this.persist();
    }
    this.onStatus(null);
  }
}
