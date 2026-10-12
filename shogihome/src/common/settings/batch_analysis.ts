export type BatchAnalysisSettings = {
  directory: string;
  subdirectories: boolean;
  skipAnalyzed: boolean;
};
export function defaultBatchAnalysisSettings(): BatchAnalysisSettings {
  return { directory: "", subdirectories: true, skipAnalyzed: true };
}
export function normalizeBatchAnalysisSettings(value: unknown): BatchAnalysisSettings {
  const raw = value && typeof value === "object" ? (value as Partial<BatchAnalysisSettings>) : {};
  return {
    directory: typeof raw.directory === "string" ? raw.directory : "",
    subdirectories: typeof raw.subdirectories === "boolean" ? raw.subdirectories : true,
    skipAnalyzed: typeof raw.skipAnalyzed === "boolean" ? raw.skipAnalyzed : true,
  };
}
