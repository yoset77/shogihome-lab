import {
  decodeBatchPlan,
  decodeBatchFiles,
  readBatchSource,
  readBatchProgress,
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
    });
    expect(
      normalizeBatchAnalysisSettings({
        sourceFormats: [".kif"],
        directory: "games",
        skipAnalyzed: false,
      }),
    ).toEqual({ directory: "games", subdirectories: true, skipAnalyzed: false });
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
