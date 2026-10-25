import { MAX_BATCH_PARALLELISM } from "@/common/analysis/batch";

export type BatchAnalysisSettings = {
  directory: string;
  subdirectories: boolean;
  skipAnalyzed: boolean;
  parallelism: number;
};
export function defaultBatchAnalysisSettings(): BatchAnalysisSettings {
  return { directory: "", subdirectories: true, skipAnalyzed: true, parallelism: 1 };
}
export function normalizeBatchAnalysisSettings(value: unknown): BatchAnalysisSettings {
  const raw = value && typeof value === "object" ? (value as Partial<BatchAnalysisSettings>) : {};
  return {
    directory: typeof raw.directory === "string" ? raw.directory : "",
    subdirectories: typeof raw.subdirectories === "boolean" ? raw.subdirectories : true,
    skipAnalyzed: typeof raw.skipAnalyzed === "boolean" ? raw.skipAnalyzed : true,
    parallelism:
      typeof raw.parallelism === "number" &&
      Number.isInteger(raw.parallelism) &&
      raw.parallelism >= 1 &&
      raw.parallelism <= MAX_BATCH_PARALLELISM
        ? raw.parallelism
        : 1,
  };
}
