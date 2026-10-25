import {
  decodeBatchPlan,
  decodeBatchFiles,
  readBatchSource,
  readBatchProgress,
  MAX_BATCH_PARALLELISM,
} from "@/common/analysis/batch";
import { decodeBatchJobRequest } from "@/common/analysis/types";
import {
  defaultBatchAnalysisSettings,
  normalizeBatchAnalysisSettings,
} from "@/common/settings/batch_analysis";
import { requestFor } from "@/tests/server/helpers/analysis";
describe("batch analysis protocol", () => {
  const input = {
    requestId: "request",
    serverInstanceId: "server",
    planId: "plan",
    options: requestFor().options,
    skipAnalyzed: true,
    fileOptions: {
      autoDetect: true,
      returnCode: "\n",
      useCSAV3: false,
      useUTF8ForKifAndKi2: false,
    },
  };
  it("preserves the six-format policy without accepting a format-selection setting", () => {
    expect(defaultBatchAnalysisSettings()).toEqual({
      directory: "",
      subdirectories: true,
      skipAnalyzed: true,
      parallelism: 1,
    });
    expect(
      normalizeBatchAnalysisSettings({
        sourceFormats: [".kif"],
        directory: "games",
        skipAnalyzed: false,
      }),
    ).toEqual({ directory: "games", subdirectories: true, skipAnalyzed: false, parallelism: 1 });
    expect(decodeBatchJobRequest(input).ok).toBe(true);
  });
  it.each([
    null,
    { ...input, skipAnalyzed: "true" },
    { ...input, fileOptions: { ...input.fileOptions, returnCode: "bad" } },
    { ...input, options: { ...input.options, overrideMultiPV: true, multiPV: 11 } },
  ])("rejects malformed creation input", (value) => {
    expect(decodeBatchJobRequest(value).ok).toBe(false);
  });
  it("defaults legacy requests to one worker and preserves explicit parallelism", () => {
    expect(decodeBatchJobRequest(input)).toMatchObject({ ok: true, value: { parallelism: 1 } });
    expect(decodeBatchJobRequest({ ...input, parallelism: MAX_BATCH_PARALLELISM })).toMatchObject({
      ok: true,
      value: { parallelism: MAX_BATCH_PARALLELISM },
    });
    expect(normalizeBatchAnalysisSettings({ parallelism: 4 }).parallelism).toBe(4);
  });
  it.each([null, 0, -1, 1.5, "2", MAX_BATCH_PARALLELISM + 1])(
    "rejects invalid parallelism %s and safely normalizes stored settings",
    (parallelism) => {
      expect(decodeBatchJobRequest({ ...input, parallelism }).ok).toBe(false);
      expect(normalizeBatchAnalysisSettings({ parallelism }).parallelism).toBe(1);
    },
  );
  const progress = {
    totalFiles: 3,
    processedFiles: 1,
    currentFile: 0,
    currentPath: "",
    recordIndex: 0,
    recordPath: "",
    saved: false,
    successTotal: 1,
    failedTotal: 0,
    skippedTotal: 0,
  };
  it("validates parallel activity against both the worker limit and remaining files", () => {
    const parallel = { parallelism: 2, activeFiles: 2 };
    expect(readBatchProgress({ ...progress, parallel })).toEqual({ ...progress, parallel });
    for (const value of [
      { parallelism: 1, activeFiles: 1 },
      { parallelism: 2, activeFiles: 3 },
      { parallelism: 4, activeFiles: 3 },
      { parallelism: MAX_BATCH_PARALLELISM + 1, activeFiles: 0 },
      { parallelism: 2, activeFiles: -1 },
      { activeFiles: 0 },
    ])
      expect(() => readBatchProgress({ ...progress, parallel: value })).toThrow();
  });
  it("rejects unknown source kinds, invalid filters, and invalid plan lists", () => {
    expect(() => readBatchSource({ kind: "local", directory: "/tmp" })).toThrow();
    expect(() => readBatchSource({ kind: "search", search: { strategy: "unknown" } })).toThrow();
    expect(() => readBatchSource({ kind: "search", search: { sfen: "garbage" } })).toThrow();
    expect(decodeBatchPlan({ planId: "plan", files: [], expiresAt: 1 }).ok).toBe(false);
    expect(decodeBatchPlan({ planId: "plan", files: ["a.kifu", "a.kifu"], expiresAt: 1 }).ok).toBe(
      false,
    );
    expect(decodeBatchFiles([{ index: 2, path: "a.kifu", state: "saved" }]).ok).toBe(false);
  });
  it("rejects inconsistent progress counters", () => {
    expect(() =>
      readBatchProgress({
        totalFiles: 2,
        processedFiles: 1,
        successTotal: 2,
        failedTotal: 0,
        skippedTotal: 0,
      }),
    ).toThrow();
  });
});
