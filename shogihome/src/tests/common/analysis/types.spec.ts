import {
  decodeAnalysisCapabilities,
  decodeAnalysisJobRequest,
  decodeAnalysisResult,
  decodeAnalysisStatus,
} from "@/common/analysis/types";
import { requestFor } from "@/tests/server/helpers/analysis";

describe("analysis boundary codecs", () => {
  it("round trips canonical requests", () => {
    const request = requestFor();
    const decoded = decodeAnalysisJobRequest(JSON.parse(JSON.stringify(request)));
    expect(decoded).toEqual({ ok: true, value: request });
  });

  it.each([NaN, Infinity, -1, "1", null])("rejects invalid timer %j", (value) => {
    const request = requestFor();
    request.options.perMoveCriteria.maxSeconds = value as number;
    expect(decodeAnalysisJobRequest(request).ok).toBe(false);
  });

  it("rejects capabilities and response shapes rather than trusting typed JSON", () => {
    expect(
      decodeAnalysisCapabilities({
        serverInstanceId: "id",
        pollMs: 0,
        maxInputBytes: 10,
        maxNodes: 10,
      }).ok,
    ).toBe(false);
    expect(decodeAnalysisStatus({ state: "running" }).ok).toBe(false);
    const node = { id: "node", revision: 1, comment: "annotation" };
    const result = { jobId: "job", serverInstanceId: "server", revision: 1, nodes: [node, node] };
    expect(decodeAnalysisResult(result).ok).toBe(false);
    expect(decodeAnalysisResult({ ...result, nodes: [{ ...node, revision: 2 }] }).ok).toBe(false);
    expect(
      decodeAnalysisResult({ ...result, nodes: [{ ...node, researchInfo: { score: Infinity } }] })
        .ok,
    ).toBe(false);
  });
});
