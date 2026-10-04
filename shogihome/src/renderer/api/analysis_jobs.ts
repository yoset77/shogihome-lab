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
import { analysisTexts } from "@/common/i18n/analysis";
import { createApiRequestOptions, createHonoApiClient, parseJsonResponse } from "./client";

export interface AnalysisJobsClient {
  capabilities(): Promise<AnalysisCapabilities>;
  create(request: AnalysisJobRequest): Promise<AnalysisJobStatus>;
  byRequest(id: string): Promise<AnalysisJobStatus>;
  status(id: string): Promise<AnalysisJobStatus>;
  source(id: string): Promise<RecordSnapshot>;
  result(id: string, afterRevision: number): Promise<AnalysisJobResult>;
  cancel(id: string): Promise<AnalysisJobStatus>;
}

async function decode<T>(
  response: Response,
  decoder: (value: unknown) => DecodeResult<T>,
): Promise<T> {
  const result = decoder(await parseJsonResponse<unknown>(response));
  if (!result.ok) throw new Error(analysisTexts().invalid);
  return result.value;
}

export function createAnalysisJobsClient(): AnalysisJobsClient {
  const client = createHonoApiClient().api["analysis-jobs"];
  return {
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
    status: async (id) =>
      decode(await client[":jobId"].$get({ param: { jobId: id } }), decodeAnalysisStatus),
    source: async (id) =>
      decode(await client[":jobId"].source.$get({ param: { jobId: id } }), decodeRecordSnapshot),
    result: async (id, afterRevision) =>
      decode(
        await client[":jobId"].result.$get({
          param: { jobId: id },
          query: { afterRevision: String(afterRevision) },
        }),
        decodeAnalysisResult,
      ),
    cancel: async (id) =>
      decode(await client[":jobId"].cancel.$post({ param: { jobId: id } }), decodeAnalysisStatus),
  };
}
