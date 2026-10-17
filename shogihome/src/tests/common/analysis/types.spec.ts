import {
  decodeAnalysisCapabilities,
  decodeAnalysisJobRequest,
  decodeAnalysisResult,
  decodeAnalysisStatus,
  parseAnalysisInfo,
  readUSIInfo,
} from "@/common/analysis/types";
import { USI_PV_ENDS } from "@/common/game/usi";
import { MAX_SNAPSHOT_PV } from "@/common/record/snapshot";
import { requestFor } from "@/tests/server/helpers/analysis";

describe("analysis boundary codecs", () => {
  it.each(USI_PV_ENDS)("accepts %s only as the final PV token", (end) => {
    const info = { scoreCP: 0, lowerbound: true, pv: ["7g7f", end] };
    expect(readUSIInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
    expect(parseAnalysisInfo(`info\tscore cp 0 lowerbound pv  7g7f\t${end} `)).toEqual(info);
    expect(readUSIInfo({ pv: [end] })).toEqual({ pv: [end] });
    expect(() => readUSIInfo({ pv: [end, "7g7f"] })).toThrow();
    expect(() => readUSIInfo({ pv: ["7g7f", end, "win"] })).toThrow();
    expect(parseAnalysisInfo(`info score cp 0 pv ${end} 7g7f`)).toBeNull();
    expect(() => readUSIInfo({ currmove: end })).toThrow();
  });

  it.each(["rep_none", "rep_unknown", "rep_draw_extra", "invalid", "<script>"])(
    "rejects unknown PV token %s",
    (token) => {
      expect(parseAnalysisInfo(`info score cp 0 pv 7g7f ${token}`)).toBeNull();
      expect(() => readUSIInfo({ pv: ["7g7f", token] })).toThrow();
    },
  );

  it("preserves numeric, score-bound and PV-size validation with extended PVs", () => {
    const pv = ["7g7f", "rep_draw"];
    for (const extra of [
      { depth: NaN },
      { scoreCP: Infinity },
      { nodes: -1 },
      { multipv: 11 },
      { scoreCP: undefined, lowerbound: true },
      { lowerbound: true, upperbound: true },
    ]) {
      expect(() => readUSIInfo({ scoreCP: 0, pv, ...extra })).toThrow();
    }
    expect(() => readUSIInfo({ pv: Array(MAX_SNAPSHOT_PV + 1).fill("7g7f") })).toThrow();
    const moves = Array(MAX_SNAPSHOT_PV - 1)
      .fill("7g7f")
      .join(" ");
    expect(parseAnalysisInfo(`info score cp 0 pv ${moves} rep_draw 3c3d`)).toBeNull();
    expect(parseAnalysisInfo(`info pv ${moves} 7g7f 3c3d`)?.pv).toHaveLength(MAX_SNAPSHOT_PV);
  });

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
