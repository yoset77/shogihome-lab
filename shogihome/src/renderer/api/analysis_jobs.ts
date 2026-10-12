import {
  decodeAnalysisCapabilities,
  decodeAnalysisResult,
  decodeAnalysisStatus,
  type AnalysisCapabilities,
  type AnalysisJobRequest,
  type AnalysisJobResult,
  type AnalysisJobStatus,
} from "@/common/analysis/types";
import { decodeRecordSnapshot, type RecordSnapshot } from "@/common/record/snapshot";
import type { DecodeResult } from "@/common/engine/relay_protocol";
import { t } from "@/common/i18n/index";
import { createApiRequestOptions, createHonoApiClient, parseJsonResponse } from "./client";
import {
  decodeJobBinding,
  decodeJobList,
  decodeJobOperationOutcome,
  type JobOperationOutcome,
  type JobAttachRequest,
  type JobBinding,
  type JobSummary,
} from "@/common/jobs/types";

export interface AnalysisJobsClient {
  cancelOutcome(id: string, requestId: string): Promise<JobOperationOutcome>;
  list(): Promise<JobSummary[]>;
  attach(id: string, request: JobAttachRequest): Promise<JobBinding>;
  detach(id: string, binding: JobBinding): Promise<AnalysisJobStatus>;
  capabilities(): Promise<AnalysisCapabilities>;
  create(request: AnalysisJobRequest): Promise<AnalysisJobStatus>;
  byRequest(id: string): Promise<AnalysisJobStatus>;
  status(id: string, binding?: JobBinding): Promise<AnalysisJobStatus>;
  source(id: string): Promise<RecordSnapshot>;
  result(id: string, afterRevision: number, binding?: JobBinding): Promise<AnalysisJobResult>;
  cancel(
    id: string,
    binding?: JobBinding,
    requestId?: string,
    authorization?: JobBinding,
  ): Promise<AnalysisJobStatus>;
}

async function decode<T>(
  response: Response,
  decoder: (value: unknown) => DecodeResult<T>,
): Promise<T> {
  const result = decoder(await parseJsonResponse<unknown>(response));
  if (!result.ok) throw new Error(t.analysisJobInvalid);
  return result.value;
}

export function createAnalysisJobsClient(): AnalysisJobsClient {
  const client = createHonoApiClient().api["analysis-jobs"];
  return {
    cancelOutcome: async (id, requestId) =>
      decode(
        await client[":jobId"].cancellations[":requestId"].$get({
          param: { jobId: id, requestId },
        }),
        decodeJobOperationOutcome,
      ),
    list: async () => decode(await client.$get(), decodeJobList),
    attach: async (id, request) =>
      decode(
        await client[":jobId"].attach.$post({ param: { jobId: id }, json: request }),
        decodeJobBinding,
      ),
    detach: async (id, binding) =>
      decode(
        await client[":jobId"].detach.$post({ param: { jobId: id }, json: binding }),
        decodeAnalysisStatus,
      ),
    capabilities: async () => decode(await client.capabilities.$get(), decodeAnalysisCapabilities),
    create: async (request) =>
      decode(
        await client.$post({ json: request }, createApiRequestOptions({ timeoutMs: 30_000 })),
        decodeAnalysisStatus,
      ),
    byRequest: async (id) =>
      decode(
        await client["by-request"][":requestId"].$get({ param: { requestId: id } }),
        decodeAnalysisStatus,
      ),
    status: async (id, binding) =>
      decode(
        binding
          ? await client[":jobId"]["attached-status"].$post({ param: { jobId: id }, json: binding })
          : await client[":jobId"].$get({ param: { jobId: id } }),
        decodeAnalysisStatus,
      ),
    source: async (id) =>
      decode(await client[":jobId"].source.$get({ param: { jobId: id } }), decodeRecordSnapshot),
    result: async (id, afterRevision, binding) =>
      decode(
        await client[":jobId"].result.$get({
          param: { jobId: id },
          query: {
            afterRevision: String(afterRevision),
            ...(binding
              ? {
                  ownerId: binding.ownerId,
                  epoch: String(binding.epoch),
                  screenId: binding.screenId,
                  recoveryId: binding.recoveryId,
                }
              : {}),
          },
        }),
        decodeAnalysisResult,
      ),
    cancel: async (id, binding, requestId, authorization) =>
      decode(
        binding
          ? await client[":jobId"]["attached-cancel"].$post({
              param: { jobId: id },
              json: {
                ...binding,
                ...(requestId ? { requestId } : {}),
                ...(authorization ? { authorization } : {}),
              },
            })
          : await client[":jobId"].cancel.$post({ param: { jobId: id } }),
        decodeAnalysisStatus,
      ),
  };
}
