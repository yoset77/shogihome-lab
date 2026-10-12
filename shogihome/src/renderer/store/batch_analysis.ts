import {
  normalizeBatchAnalysisSettings,
  type BatchAnalysisSettings,
} from "@/common/settings/batch_analysis";
import { createAnalysisJobsClient } from "@/renderer/api/analysis_jobs";
import type { BatchAnalysisSource } from "@/common/analysis/batch";
const KEY = "shogihome-batch-analysis-settings";
export function loadBatchAnalysisSettings(): BatchAnalysisSettings {
  try {
    return normalizeBatchAnalysisSettings(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return normalizeBatchAnalysisSettings(undefined);
  }
}
export function saveBatchAnalysisSettings(settings: BatchAnalysisSettings): void {
  localStorage.setItem(KEY, JSON.stringify(normalizeBatchAnalysisSettings(settings)));
}
export const prepareBatchAnalysis = (source: BatchAnalysisSource) =>
  createAnalysisJobsClient().prepareBatch(source);
