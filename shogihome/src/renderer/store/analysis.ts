import { Record as ShogiRecord, type ImmutableNode } from "tsshogi";
import {
  DEFAULT_ANALYSIS_POLL_MS,
  decodeAnalysisJobRequest,
  isAnalysisTerminal,
  type AnalysisJobError,
  type AnalysisJobRequest,
  type AnalysisJobStatus,
  decodeBatchJobRequest,
} from "@/common/analysis/types";
import { identifier, object, counter } from "@/common/analysis/validation";
import type { BatchAnalysisPlan, BatchAnalysisJobRequest } from "@/common/analysis/batch";
import { TextDecodingRule } from "@/common/settings/app";
import { t } from "@/common/i18n/index";
import { snapshotRecord, indexRecordNodes, type RecordSnapshot } from "@/common/record/snapshot";
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
import { JobStorage } from "./job_storage";
import { jobRecordContent as recordContent } from "./job_record";
import {
  readJobBinding,
  readJobAttachRequest,
  type JobAttachmentState,
  type JobAttachRequest,
  type JobBinding,
  type JobSummary,
} from "@/common/jobs/types";
import { ConnectionNotification } from "@/renderer/helpers/connection_notification";

const STORAGE_KEY = "shogihome-analysis-job";

function analysisJobErrorMessage(error: AnalysisJobError): string {
  switch (error) {
    case "engine":
      return t.analysisEngineError;
    case "expired":
      return t.analysisJobExpired;
    case "capacity":
      return t.analysisJobCapacity;
    case "deadline":
      return t.analysisJobDeadline;
    default:
      return t.analysisJobInvalid;
  }
}

const MONITOR_SESSION_ID = 200100;
const MAX_TIMER_MS = 2 ** 31 - 1;
const SCREEN_ID = generateSessionId();
type Reference = {
  requestId: string;
  serverInstanceId: string;
  jobId?: string;
  cancelRequested?: boolean;
  ownerId?: string;
  binding?: JobBinding;
  content?: string;
  pendingAttach?: JobAttachRequest;
  cancelRequestId?: string;
  cancelBinding?: JobBinding;
  pendingDetach?: JobBinding;
  recordIndex?: number;
};
type FinishCallback = (status?: AnalysisJobStatus) => void;
type ErrorCallback = (error: unknown) => void;
type StatusCallback = (status: AnalysisJobStatus | null) => void;

function readReference(raw: string | null): Reference | undefined {
  try {
    if (!raw) return;
    const value = object(JSON.parse(raw));
    return {
      requestId: identifier(value.requestId),
      serverInstanceId: identifier(value.serverInstanceId),
      ...(value.jobId === undefined ? {} : { jobId: identifier(value.jobId) }),
      cancelRequested: value.cancelRequested === true,
      ...(value.cancelRequestId === undefined
        ? {}
        : { cancelRequestId: identifier(value.cancelRequestId) }),
      ...(value.cancelBinding === undefined
        ? {}
        : { cancelBinding: readJobBinding(value.cancelBinding) }),
      ...(value.pendingDetach === undefined
        ? {}
        : { pendingDetach: readJobBinding(value.pendingDetach) }),
      ...(value.ownerId === undefined ? {} : { ownerId: identifier(value.ownerId) }),
      ...(value.binding === undefined ? {} : { binding: readJobBinding(value.binding) }),
      ...(typeof value.content === "string" ? { content: value.content } : {}),
      ...(value.recordIndex === undefined ? {} : { recordIndex: counter(value.recordIndex) }),
      ...(value.pendingAttach === undefined
        ? {}
        : { pendingAttach: readJobAttachRequest(value.pendingAttach) }),
    };
  } catch {
    return;
  }
}
const storage = new JobStorage(
  "analysis",
  STORAGE_KEY,
  readReference,
  (ref) => ({ ...ref, content: undefined }),
  (ref) => [
    ...(!ref.jobId
      ? [
          {
            id: "creation",
            reference: {
              ...ref,
              cancelRequested: undefined,
              cancelRequestId: undefined,
              cancelBinding: undefined,
              pendingAttach: undefined,
            },
          },
        ]
      : []),
    ...(ref.pendingAttach
      ? [
          {
            id: "attachment",
            reference: {
              ...ref,
              cancelRequested: undefined,
              cancelRequestId: undefined,
              cancelBinding: undefined,
            },
          },
        ]
      : []),
    ...(ref.cancelRequested
      ? [{ id: ref.cancelRequestId ?? "cancel", reference: { ...ref, pendingAttach: undefined } }]
      : []),
    ...(ref.pendingDetach
      ? [
          {
            id: "detach",
            reference: { ...ref, pendingAttach: undefined, cancelRequested: undefined },
          },
        ]
      : []),
    ...(ref.jobId && !ref.pendingAttach && !ref.cancelRequested
      ? [{ id: "creation", reference: ref }]
      : []),
  ],
);
function loadReferences(): Reference[] {
  const ref = storage.load();
  if (!ref) return [];
  const pending = storage
    .journal()
    .filter(
      (value) =>
        value.requestId === ref.requestId &&
        value.serverInstanceId === ref.serverInstanceId &&
        value.ownerId === ref.ownerId,
    );
  const cancel = pending.find((value) => value.cancelRequested);
  return [
    {
      ...ref,
      cancelRequested: cancel?.cancelRequested,
      cancelRequestId: cancel?.cancelRequestId,
      cancelBinding: cancel?.cancelBinding,
      pendingAttach: pending.find((value) => value.pendingAttach)?.pendingAttach,
    },
  ];
}
function forgetReference(ref: Reference): void {
  storage.detach(ref);
  storage.forgetJournal(ref);
}

export class AnalysisManager {
  private reference?: Reference;
  private background = false;
  private pendingRequest?: AnalysisJobRequest;
  private pendingBatchRequest?: BatchAnalysisJobRequest;
  private batchRecordIndex = 0;
  private active = false;
  private starting = false;
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
  private lastSearchId = 0;
  private onFinish: FinishCallback = () => {};
  private onError: ErrorCallback = () => {};
  private onStatus: StatusCallback = () => {};
  private readonly connection = new ConnectionNotification("analysis-connection");

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
  get isStarting(): boolean {
    return this.starting;
  }
  get status(): AnalysisJobStatus | undefined {
    return this._status;
  }
  get reconnecting(): boolean {
    return this._reconnecting;
  }
  get hasRetainedJob(): boolean {
    return this.active ? !!this.reference : loadReferences().length > 0;
  }
  get isCancelling(): boolean {
    return !!this.reference?.cancelRequested || this._status?.state === "cancelling";
  }

  async reconcilePending(): Promise<void> {
    for (const ref of storage.journal()) {
      try {
        const capabilities = await this.client.capabilities();
        if (capabilities.serverInstanceId !== ref.serverInstanceId) {
          storage.forgetJournal(ref);
          continue;
        }
        const status = ref.jobId
          ? await this.client.status(ref.jobId)
          : await this.client.byRequest(ref.requestId);
        storage.forgetOperation(ref, "creation");
        if (
          ref.pendingDetach &&
          status.attachment &&
          status.attachment.epoch !== ref.pendingDetach.epoch
        )
          storage.forgetOperation(ref, "detach");
        if (ref.cancelRequested) {
          const resolved = ref.cancelRequestId
            ? (await this.client.cancelOutcome(status.jobId, ref.cancelRequestId)).state ===
              "accepted"
            : false;
          if (
            resolved ||
            isAnalysisTerminal(status.state) ||
            (ref.cancelBinding &&
              (ref.cancelBinding.generation !== undefined
                ? status.attachment?.generation !== ref.cancelBinding.generation
                : status.attachment?.epoch !== ref.cancelBinding.epoch))
          )
            storage.forgetOperation(ref, ref.cancelRequestId ?? "cancel");
        }
        if (
          ref.pendingAttach &&
          status.attachment &&
          status.attachment.epoch > ref.pendingAttach.epoch
        )
          storage.forgetOperation(ref, "attachment");
      } catch (error) {
        if (error instanceof ApiResponseError && error.status === 410) storage.forgetJournal(ref);
        else if (!this.isTransient(error)) throw error;
      }
    }
  }

  private persist(): void {
    const ref = this.reference;
    if (!ref) return;
    if (!ref.jobId || ref.cancelRequested || ref.pendingAttach)
      storage.writeJournal({ ...ref, content: undefined });
    else storage.forgetJournal(ref);
    if (!this.background)
      storage.save({ ...ref, cancelRequested: undefined, pendingAttach: undefined });
  }

  private bind(token: string): RecordSnapshot {
    const source = this.recordManager.beginAnalysis(token);
    this.nodeIndex = indexRecordNodes(this.recordManager.record);
    this.activate();
    return source;
  }

  private activate(monitor = true): void {
    ++this.generation;
    this.lastSearchId = 0;
    this.batchRecordIndex = 0;
    this.revision = 0;
    this.active = true;
    this.starting = false;
    this._status = undefined;
    this._reconnecting = false;
    setInfoSessionActive(MONITOR_SESSION_ID, monitor);
    this.onStatus(null);
  }

  startBatch(
    settings: AnalysisSettings,
    plan: BatchAnalysisPlan,
    skipAnalyzed: boolean,
    background = false,
  ) {
    return this.start(settings, background, { plan, skipAnalyzed });
  }

  async start(
    settings: AnalysisSettings,
    background = false,
    batch?: { plan: BatchAnalysisPlan; skipAnalyzed: boolean },
  ): Promise<void> {
    if (!this.active) this.reference = loadReferences()[0];
    if (this.reference || this.active) throw new Error(t.analysisJobCapacity);
    if (
      !settings.usi ||
      (settings.usi.uri !== "lan-engine" && !settings.usi.uri.startsWith("lan-engine:"))
    )
      throw new Error(t.analysisJobInvalid);
    const requestId = generateSessionId();
    this.background = background;
    this.connection.reset();
    let source: RecordSnapshot | undefined;
    if (batch && background) this.activate(false);
    else source = this.bind(requestId);
    this.starting = !background;
    const generation = this.generation;
    try {
      const app = useAppSettings();
      const options = { ...settings };
      delete options.usi;
      const input = {
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
      const decoded = batch
        ? decodeBatchJobRequest(
            JSON.parse(
              JSON.stringify({
                requestId,
                serverInstanceId: "pending",
                planId: batch.plan.planId,
                options: input.options,
                skipAnalyzed: batch.skipAnalyzed,
                fileOptions: {
                  autoDetect: app.textDecodingRule === TextDecodingRule.AUTO_DETECT,
                  returnCode: app.returnCode,
                  useCSAV3: app.useCSAV3,
                  useUTF8ForKifAndKi2: app.useUTF8ForKifAndKi2,
                },
              }),
            ),
          )
        : decodeAnalysisJobRequest(JSON.parse(JSON.stringify(input)));
      if (!decoded.ok) throw new Error(batch ? t.batchAnalysisInvalid : t.analysisJobInvalid);
      const request = decoded.value;
      if (batch && !background) {
        await this.recordManager.saveBackup();
        if (generation !== this.generation) return;
      }
      const capabilities = await this.client.capabilities();
      if (generation !== this.generation) return;
      request.serverInstanceId = capabilities.serverInstanceId;
      if (new TextEncoder().encode(JSON.stringify(request)).length > capabilities.maxInputBytes)
        throw new Error(t.analysisJobCapacity);
      this.reference = {
        requestId,
        serverInstanceId: capabilities.serverInstanceId,
        ownerId: generateSessionId(),
        ...(source ? { content: recordContent(source) } : {}),
      };
      if ("planId" in request) {
        this.pendingBatchRequest = request;
      } else this.pendingRequest = request;
      this.persist();
      this.pollMs = capabilities.pollMs;
      this.resetRetry();
      try {
        const status =
          "planId" in request
            ? await this.client.createBatch(request)
            : await this.client.create(request);
        if (generation !== this.generation) return;
        if (background) {
          this.checkStatus(status);
          this.reference.jobId = status.jobId;
          this.persist();
        } else this.acceptStatus(status);
        this.pendingRequest = undefined;
        this.pendingBatchRequest = undefined;
        if (!background) await this.claim(status);
      } catch (error) {
        if (generation !== this.generation) return;
        if (!this.isTransient(error) || (error instanceof ApiResponseError && error.status === 503))
          throw error;
        this.backoff(error);
      }
      if (generation !== this.generation) return;
      if (background) {
        if (source) this.recordManager.endAnalysis(requestId);
        this.active = false;
        setInfoSessionActive(MONITOR_SESSION_ID, false);
        this.onStatus(null);
        if (this.reference?.jobId) this.reference = undefined;
      }
      this.schedule();
    } catch (error) {
      if (generation !== this.generation) return;
      const rejected =
        error instanceof ApiResponseError && [400, 409, 410, 413, 503].includes(error.status);
      this.release(requestId, !this.reference || rejected);
      throw error;
    }
  }

  async resume(confirmRecovery: () => Promise<boolean>): Promise<boolean> {
    if (this.active || this.recovering) return false;
    this.reference = loadReferences()[0];
    this.background = false;
    const ref = this.reference;
    if (!ref) return false;
    this.connection.reset();
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
    let generation = this.generation;
    try {
      const capabilities = await this.client.capabilities();
      if (generation !== this.generation) return false;
      if (capabilities.serverInstanceId !== ref.serverInstanceId)
        throw new ApiResponseError(410, t.analysisJobExpired);
      this.pollMs = capabilities.pollMs;
      if (!this._reconnecting) this.retryMs = this.pollMs;
      let status = ref.jobId
        ? await this.client.status(ref.jobId)
        : await this.client.byRequest(ref.requestId);
      if (generation !== this.generation) return false;
      this.checkStatus(status);
      ref.jobId = status.jobId;
      this.persist();
      this.checkStatus(status);
      this.onStatus(status);
      if (status.batch?.recordIndex === 0) {
        if (
          !isAnalysisTerminal(status.state) &&
          !(await this.protectPendingBatch(confirmRecovery, generation, false))
        )
          return false;
        if (ref.pendingAttach || !isAnalysisTerminal(status.state)) await this.claim(status);
        if (generation !== this.generation) return false;
        this.needsRecovery = false;
        this.acceptStatus(status);
        this.resetRetry();
        if (isAnalysisTerminal(status.state)) this.finish(status);
        else this.schedule();
        return true;
      }
      const recordIndex = status.batch?.recordIndex;
      const source = await this.client.source(status.jobId, recordIndex);
      if (generation !== this.generation) return false;
      const result = await this.client.result(
        status.jobId,
        0,
        undefined,
        status.batch?.recordIndex,
      );
      if (generation !== this.generation) return false;
      this.checkResult(result.jobId, result.serverInstanceId, status.jobId, result.attachment);
      if (status.batch && result.recordIndex !== status.batch.recordIndex)
        throw new ApiResponseError(423, t.batchAnalysisPreparing);
      if (result.revision < status.resultRevision) throw new Error(t.analysisJobInvalid);
      const projected = structuredClone(source);
      for (const update of result.nodes) {
        const node = projected.nodes.find((node) => node.id === update.id);
        if (!node) throw new Error(t.analysisJobInvalid);
        node.comment = update.comment;
        if (update.researchInfo)
          node.customData = { ...node.customData, researchInfo: update.researchInfo };
      }
      const local = recordContent(snapshotRecord(this.recordManager.record));
      if (
        local !== ref.content &&
        local !== recordContent(source) &&
        local !== recordContent(projected)
      ) {
        const confirmed = await confirmRecovery();
        if (generation !== this.generation) return false;
        if (!confirmed) {
          this.release(ref.requestId, false);
          return false;
        }
        this.recordManager.endAnalysis(ref.requestId);
        await this.recordManager.openAnalysisSnapshot(source, () => generation === this.generation);
        if (generation !== this.generation) return false;
        this.bind(ref.requestId);
        generation = this.generation;
      }
      if (ref.pendingAttach || !isAnalysisTerminal(status.state)) await this.claim(status);
      if (generation !== this.generation) return false;
      if (ref.cancelRequested && !isAnalysisTerminal(status.state)) {
        status = await this.client.cancel(
          status.jobId,
          ref.cancelBinding ?? ref.binding,
          ref.cancelRequestId,
          ref.binding,
        );
        if (generation !== this.generation) return false;
        ref.cancelRequested = undefined;
        storage.forgetOperation(ref, ref.cancelRequestId ?? "cancel");
        this.persist();
      }
      if (status.batch && status.batch.recordIndex !== recordIndex)
        throw new ApiResponseError(423, t.batchAnalysisPreparing);
      if (status.batch) {
        this.recordManager.switchBatchAnalysis(ref.requestId, source, status.batch.recordPath);
        this.nodeIndex = indexRecordNodes(this.recordManager.record);
        this.batchRecordIndex = status.batch.recordIndex;
        ref.recordIndex = this.batchRecordIndex;
      }
      if (!this.recordManager.applyAnalysisResults(ref.requestId, result.nodes))
        throw new Error(t.analysisJobInvalid);
      this.revision = result.revision;
      ref.content = recordContent(snapshotRecord(this.recordManager.record));
      this.needsRecovery = false;
      this.resetRetry();
      this.acceptStatus(status);
      if (status.batch?.saved)
        this.recordManager.markAsSaved("server://" + status.batch.recordPath, true);
      this.connection.restored();
      if (isAnalysisTerminal(status.state)) this.finish(status);
      else this.schedule();
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      if (this.isTransient(error)) {
        this.backoff(error);
        this.scheduleRecovery(confirmRecovery);
        return false;
      } else {
        if (error instanceof ApiResponseError && error.status === 409) storage.detach(ref);
        this.release(ref.requestId, error instanceof ApiResponseError && error.status === 410);
      }
      throw error;
    } finally {
      if (generation === this.generation || this.reference === ref) this.recovering = false;
    }
  }

  close(): void {
    if (!this.active || !this.reference) return;
    const previous = this.reference.cancelRequested;
    this.reference.cancelRequested = true;
    this.reference.cancelRequestId ??= generateSessionId();
    this.reference.cancelBinding ??= this.reference.binding;
    try {
      storage.writeJournal(this.reference);
    } catch (error) {
      this.reference.cancelRequested = previous;
      this.onError(error);
      return;
    }
    this.starting = false;
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
  suspend(): void {
    const ref = this.reference;
    if (!ref) return;
    this.release(ref.requestId, false);
    if (ref.jobId && ref.binding && navigator.sendBeacon)
      navigator.sendBeacon(
        `/api/analysis-jobs/${ref.jobId}/suspend`,
        new Blob([JSON.stringify(ref.binding)], { type: "application/json" }),
      );
  }

  private async claim(status: AnalysisJobStatus): Promise<void> {
    const ref = this.reference!;
    ref.ownerId ??= generateSessionId();
    ref.pendingAttach ??= {
      ownerId: ref.ownerId,
      epoch: ref.binding?.epoch ?? 0,
      recoveryId: ref.binding?.recoveryId,
      screenId: SCREEN_ID,
      takeover: false,
    };
    ref.pendingAttach.screenId = SCREEN_ID;
    this.persist();
    const binding = await this.client.attach(status.jobId, ref.pendingAttach);
    if (this.reference !== ref || !this.active) {
      void this.client.detach(status.jobId, binding).catch(() => {});
      return;
    }
    ref.binding = binding;
    ref.pendingAttach = undefined;
    storage.forgetOperation(ref, "attachment");
    status.attachment = { epoch: binding.epoch, generation: binding.generation, attached: true };
    this.persist();
  }

  async attach(
    job: JobSummary,
    confirmRecovery: () => Promise<boolean>,
    confirmTakeover: () => Promise<boolean>,
  ): Promise<boolean> {
    if (this.active || this.recovering) return false;
    if (job.attachment.attached && !(await confirmTakeover())) return false;
    this.background = false;
    this.reference = {
      requestId: job.requestId,
      serverInstanceId: job.serverInstanceId,
      jobId: job.id,
      ownerId: generateSessionId(),
    };
    this.reference.pendingAttach = {
      ownerId: this.reference.ownerId!,
      epoch: job.attachment.epoch,
      takeover: job.attachment.attached,
      screenId: SCREEN_ID,
    };
    this.connection.reset();
    this.bind(job.requestId);
    this.needsRecovery = true;
    let generation = this.generation;
    try {
      // Confirmation and backup must precede acquiring another screen's attachment.
      const before = await this.client.status(job.id);
      if (generation !== this.generation) return false;
      if (before.batch?.recordIndex === 0) {
        if (
          !isAnalysisTerminal(before.state) &&
          !(await this.protectPendingBatch(confirmRecovery, generation, true))
        )
          return false;
        await this.claim(before);
        if (generation !== this.generation) return false;
        return this.recover(confirmRecovery);
      }
      const [source, result] = await Promise.all([
        this.client.source(job.id, before.batch?.recordIndex),
        this.client.result(job.id, 0, undefined, before.batch?.recordIndex),
      ]);
      if (generation !== this.generation) return false;
      this.checkResult(result.jobId, result.serverInstanceId, job.id);
      if (before.batch && result.recordIndex !== before.batch.recordIndex)
        throw new ApiResponseError(423, t.batchAnalysisPreparing);
      const projected = structuredClone(source);
      for (const update of result.nodes) {
        const node = projected.nodes.find((node) => node.id === update.id);
        if (!node) throw new Error(t.analysisJobInvalid);
        node.comment = update.comment;
      }
      const local = recordContent(snapshotRecord(this.recordManager.record));
      if (local !== recordContent(source) && local !== recordContent(projected)) {
        const confirmed = await confirmRecovery();
        if (generation !== this.generation) return false;
        if (!confirmed) {
          this.release(job.requestId, true);
          return false;
        }
        this.recordManager.endAnalysis(job.requestId);
        await this.recordManager.openAnalysisSnapshot(source, () => generation === this.generation);
        if (generation !== this.generation) return false;
        this.bind(job.requestId);
        generation = this.generation;
      }
      const status = await this.client.status(job.id);
      if (generation !== this.generation) return false;
      await this.claim(status);
      if (generation !== this.generation) return false;
      return this.recover(confirmRecovery);
    } catch (error) {
      if (generation !== this.generation) return false;
      if (this.isTransient(error)) {
        this.persist();
        this.backoff(error);
        this.scheduleRecovery(confirmRecovery);
        return true;
      }
      const binding = this.reference?.binding;
      this.release(job.requestId, true);
      if (binding) void this.client.detach(job.id, binding).catch(() => {});
      throw error;
    }
  }

  detach(): void {
    const ref = this.reference;
    if (!ref) return;
    const binding =
      ref.binding ??
      (ref.pendingAttach
        ? {
            ownerId: ref.pendingAttach.ownerId,
            epoch: ref.pendingAttach.epoch + 1,
            screenId: SCREEN_ID,
          }
        : undefined);
    if (ref.jobId && binding) storage.writeJournal({ ...ref, pendingDetach: binding });
    storage.detach(ref);
    this.release(ref.requestId, false);
    this.reference = undefined;
    this.pendingRequest = undefined;
    this.pendingBatchRequest = undefined;
    if (ref.jobId && binding)
      void this.client
        .detach(ref.jobId, binding)
        .then(() => storage.forgetOperation(ref, "detach"))
        .catch((error) => this.onError(error));
  }

  private checkStatus(status: AnalysisJobStatus): void {
    const binding = this.reference?.binding;
    if (
      binding &&
      !this.reference?.pendingAttach &&
      status.attachment &&
      status.attachment.epoch !== binding.epoch
    )
      throw new ApiResponseError(409, t.jobsTransferred);
    if (
      !this.reference ||
      status.serverInstanceId !== this.reference.serverInstanceId ||
      status.requestId !== this.reference.requestId ||
      (this.reference.jobId && status.jobId !== this.reference.jobId)
    )
      throw new Error(t.analysisJobInvalid);
  }

  private checkResult(
    jobId: string,
    serverInstanceId: string,
    expectedJobId = this.reference?.jobId,
    attachment?: JobAttachmentState,
  ): void {
    const binding = this.reference?.binding;
    if (
      binding &&
      !this.reference?.pendingAttach &&
      attachment &&
      binding.epoch !== attachment.epoch
    )
      throw new ApiResponseError(409, t.jobsTransferred);
    if (
      !this.reference ||
      serverInstanceId !== this.reference.serverInstanceId ||
      jobId !== expectedJobId
    ) {
      throw new Error(t.analysisJobInvalid);
    }
  }

  private acceptStatus(status: AnalysisJobStatus): void {
    this.checkStatus(status);
    this.reference!.jobId = status.jobId;
    this.persist();
    this._status = status;
    this.onStatus(status);
    if (status.batch && status.batch.recordIndex !== this.batchRecordIndex) {
      if (isAnalysisTerminal(status.state)) this.starting = false;
      return;
    }
    const current = status.current;
    if (!current) {
      if (status.state !== "preparing" && status.state !== "running") this.starting = false;
      return;
    }
    const record = ShogiRecord.newByUSI(current.position);
    if (record instanceof Error) throw record;
    const node = this.nodeIndex.get(current.nodeId);
    if (!node || normalizeSfen(node.sfen) !== normalizeSfen(record.position.sfen))
      throw new Error(t.analysisJobInvalid);
    this.recordManager.changeNode(node);
    if (current.searchId !== this.lastSearchId) {
      triggerOnStartSearch(MONITOR_SESSION_ID, record.position);
      this.lastSearchId = current.searchId;
    }
    for (const info of current.infos)
      dispatchUSIInfoUpdate(MONITOR_SESSION_ID, record.position, status.engineName, info);
    if (status.state !== "preparing") this.starting = false;
  }

  private schedule(): void {
    if (!this.active && !(this.background && this.reference)) return;
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
    this.starting = false;
    this.connection.lost();
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
      (error instanceof ApiResponseError &&
        (error.status === 423 || error.status === 429 || error.status >= 500))
    );
  }

  private async synchronize(): Promise<void> {
    const ref = this.reference;
    if (
      !ref ||
      (!this.active && !this.background) ||
      this.polling ||
      this.recovering ||
      this.needsRecovery
    )
      return;
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
          ? await this.client.status(ref.jobId, ref.binding)
          : await this.client.byRequest(ref.requestId);
      } catch (error) {
        if (generation !== this.generation) return;
        if (!(
          error instanceof ApiResponseError &&
          error.status === 410 &&
          (this.pendingRequest || this.pendingBatchRequest)
        ))
          throw error;
        status = this.pendingBatchRequest
          ? await this.client.createBatch(this.pendingBatchRequest)
          : await this.client.create(this.pendingRequest!);
      }
      if (generation !== this.generation) return;
      this.checkStatus(status);
      ref.jobId = status.jobId;
      this.pendingRequest = undefined;
      this.pendingBatchRequest = undefined;
      this.persist();
      if (this.background) {
        this.reference = undefined;
        return;
      }
      if (!ref.binding && !isAnalysisTerminal(status.state)) await this.claim(status);
      if (ref.cancelRequested && !isAnalysisTerminal(status.state)) {
        status = await this.client.cancel(
          status.jobId,
          ref.cancelBinding ?? ref.binding,
          ref.cancelRequestId,
          ref.binding,
        );
        if (generation !== this.generation) return;
        ref.cancelRequested = undefined;
        storage.forgetOperation(ref, ref.cancelRequestId ?? "cancel");
        this.persist();
      }
      if (generation !== this.generation) return;
      this.checkStatus(status);
      const apply = !status.batch || (await this.synchronizeBatch(status, generation));
      if (generation !== this.generation) return;
      if (apply && status.resultRevision > this.revision) {
        const result = await this.client.result(
          status.jobId,
          this.revision,
          ref.binding,
          status.batch?.recordIndex,
        );
        if (generation !== this.generation) return;
        this.checkResult(result.jobId, result.serverInstanceId, status.jobId, result.attachment);
        if (status.batch && result.recordIndex !== this.batchRecordIndex)
          throw new ApiResponseError(423, t.batchAnalysisPreparing);
        if (
          result.revision < status.resultRevision ||
          result.revision < this.revision ||
          !this.recordManager.applyAnalysisResults(ref.requestId, result.nodes)
        )
          throw new Error(t.analysisJobInvalid);
        this.revision = result.revision;
        ref.content = recordContent(snapshotRecord(this.recordManager.record));
        this.persist();
      }
      this.resetRetry();
      this.acceptStatus(status);
      if (apply && status.batch?.saved)
        this.recordManager.markAsSaved("server://" + status.batch.recordPath, true);
      this.connection.restored();
      if (isAnalysisTerminal(status.state)) this.finish(status);
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.isTransient(error)) {
        this.backoff(error);
      } else {
        if (error instanceof ApiResponseError && error.status === 409) storage.detach(ref);
        this.release(ref.requestId, error instanceof ApiResponseError && error.status === 410);
        this.onError(
          error instanceof ApiResponseError && error.status === 410
            ? new Error(t.analysisJobExpired)
            : error instanceof ApiResponseError && error.status === 409
              ? new Error(t.jobsTransferred)
              : error,
        );
      }
    } finally {
      if (generation === this.generation) {
        this.polling = false;
        this.schedule();
      }
    }
  }

  private async protectPendingBatch(
    confirmRecovery: () => Promise<boolean>,
    generation: number,
    forget: boolean,
  ): Promise<boolean> {
    const ref = this.reference!;
    const local = recordContent(snapshotRecord(this.recordManager.record));
    if (this.recordManager.unsaved && local !== ref.content) {
      const confirmed = await confirmRecovery();
      if (generation !== this.generation) return false;
      if (!confirmed) {
        this.release(ref.requestId, forget);
        return false;
      }
      await this.recordManager.saveBackup();
      if (generation !== this.generation) return false;
      if (recordContent(snapshotRecord(this.recordManager.record)) !== local)
        throw new Error(t.analysisJobInvalid);
    }
    ref.content = local;
    this.persist();
    return true;
  }

  private async synchronizeBatch(status: AnalysisJobStatus, generation: number): Promise<boolean> {
    const batch = status.batch!;
    if (!batch.recordIndex) return false;
    if (batch.recordIndex === this.batchRecordIndex) return true;
    const ref = this.reference!;
    const source = await this.client.source(status.jobId, batch.recordIndex);
    const result = await this.client.result(status.jobId, 0, ref.binding, batch.recordIndex);
    if (generation !== this.generation) return false;
    this.checkResult(result.jobId, result.serverInstanceId, status.jobId, result.attachment);
    if (result.recordIndex !== batch.recordIndex)
      throw new ApiResponseError(423, t.batchAnalysisPreparing);
    if (!this.batchRecordIndex) {
      await this.recordManager.saveBackup();
      if (generation !== this.generation) return false;
    }
    this.recordManager.switchBatchAnalysis(ref.requestId, source, batch.recordPath);
    this.nodeIndex = indexRecordNodes(this.recordManager.record);
    this.batchRecordIndex = batch.recordIndex;
    ref.recordIndex = batch.recordIndex;
    this.lastSearchId = 0;
    if (!this.recordManager.applyAnalysisResults(ref.requestId, result.nodes))
      throw new Error(t.analysisJobInvalid);
    this.revision = result.revision;
    ref.content = recordContent(snapshotRecord(this.recordManager.record));
    this.persist();
    return true;
  }

  private finish(status: AnalysisJobStatus): void {
    // Keep the job linkage if browser record persistence fails.
    if (this.revision > 0) clearURLParams();
    flushRecordForWebApp(this.recordManager.record);
    const ref = this.reference;
    this.release(status.requestId, true);
    if (ref?.binding) {
      try {
        storage.writeJournal({
          ...ref,
          cancelRequested: undefined,
          pendingAttach: undefined,
          pendingDetach: ref.binding,
        });
        void this.client
          .detach(status.jobId, ref.binding)
          .then(() => storage.forgetOperation(ref, "detach"))
          .catch((error) => this.onError(error));
      } catch (error) {
        this.onError(error);
      }
    }
    if (status.error) this.onError(new Error(analysisJobErrorMessage(status.error)));
    this.onFinish(status);
  }

  private release(token: string, forget: boolean): void {
    this.starting = false;
    if (forget && this.reference?.requestId === token) forgetReference(this.reference);
    ++this.generation;
    clearTimeout(this.timer);
    this.active = false;
    this.polling = false;
    this.recovering = false;
    this.connection.reset();
    this.needsRecovery = false;
    this.recordManager.endAnalysis(token);
    setInfoSessionActive(MONITOR_SESSION_ID, false);
    if (forget) {
      this.reference = undefined;
      this.pendingRequest = undefined;
      this.pendingBatchRequest = undefined;
    }
    this.onStatus(null);
  }
}
