import { Record } from "tsshogi";
import { reactive } from "vue";
import { Hono } from "hono";
import { AnalysisManager } from "@/renderer/store/analysis";
import { RecordManager } from "@/renderer/store/record";
import { ApiResponseError } from "@/renderer/api/client";
import { createAnalysisJobsClient } from "@/renderer/api/analysis_jobs";
import { AnalysisJobManager } from "@/server/analysis/jobManager";
import { createRateLimiter } from "@/server/security";
import type { AnalysisJobsClient } from "@/renderer/api/analysis_jobs";
import type {
  AnalysisJobRequest,
  AnalysisJobStatus,
  AnalysisJobResult,
} from "@/common/analysis/types";
import { snapshotRecord, restoreRecord } from "@/common/record/snapshot";
import { analysisSettings } from "@/tests/mock/analysis";
import { loadRecordForWebApp } from "@/renderer/store/webapp";
import api from "@/renderer/ipc/api";
import { useToastStore } from "@/renderer/store/toast";
import { t } from "@/common/i18n";

vi.mock("@/renderer/ipc/api", () => ({
  isNative: () => false,
  isMobileWebApp: () => false,
  default: { log: vi.fn(), saveRecordFileBackup: vi.fn().mockResolvedValue(undefined) },
}));

const settings = { ...analysisSettings, usi: { ...analysisSettings.usi!, uri: "lan-engine:test" } };

function setup() {
  const record = Record.newByUSI("position startpos moves 7g7f 3c3d") as Record;
  const records = new RecordManager(record);
  const source = snapshotRecord(record);
  let request: AnalysisJobRequest | undefined;
  const status: AnalysisJobStatus = {
    jobId: "job",
    requestId: "",
    serverInstanceId: "server",
    state: "running",
    engineName: "test",
    completedPositions: 1,
    totalPositions: 3,
    resultRevision: 1,
    current: { nodeId: "n0", searchId: 1, position: "position startpos", infos: [{ scoreCP: 0 }] },
  };
  const result: AnalysisJobResult = {
    jobId: "job",
    serverInstanceId: "server",
    revision: 1,
    nodes: [{ id: "n1", revision: 1, comment: "analysis" }],
  };
  const response = () => ({ ...status, requestId: request!.requestId });
  const client = {
    capabilities: vi.fn(async () => ({
      serverInstanceId: "server",
      pollMs: 500,
      maxInputBytes: 10 * 1024 * 1024,
      maxNodes: 10_000,
    })),
    create: vi.fn<AnalysisJobsClient["create"]>(async (input) => {
      request = input;
      return { ...response(), state: "preparing" as const, resultRevision: 0, current: null };
    }),
    byRequest: vi.fn(async () => response()),
    status: vi.fn(async () => response()),
    source: vi.fn(async () => source),
    result: vi.fn<AnalysisJobsClient["result"]>(async () => result),
    cancel: vi.fn(async (): Promise<AnalysisJobStatus> => ({ ...response(), state: "cancelled" })),
  } satisfies AnalysisJobsClient;
  const manager = new AnalysisManager(records, client);
  const finish = vi.fn();
  const error = vi.fn();
  manager.on("finish", finish).on("error", error);
  return {
    records,
    client,
    manager,
    finish,
    error,
    source,
    status,
    result,
    response,
    acceptRequest: (input: AnalysisJobRequest) => {
      request = input;
    },
  };
}

describe("analysis job client", () => {
  const fixtures: ReturnType<typeof setup>[] = [];
  const fixture = () => {
    const value = setup();
    fixtures.push(value);
    return value;
  };
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    useToastStore().clear();
  });
  afterEach(async () => {
    for (const { manager, status } of fixtures.splice(0)) {
      status.state = "cancelled";
      manager.close();
    }
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sends frozen input, locks editing, and applies absolute node updates without duplication", async () => {
    const { manager, records, client } = fixture();
    await manager.start(settings);
    expect(client.create.mock.calls[0][0].options.engineId).toBe("test");
    expect(records.analysisLocked).toBe(true);
    records.updateComment("ignored");
    expect(records.record.current.comment).toBe("");
    expect(records.appendMove({ move: records.record.position.createMoveByUSI("2g2f")! })).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(500);
    records.changePly(1);
    expect(records.record.current.comment).toBe("analysis");
    await vi.advanceTimersByTimeAsync(1000);
    expect(records.record.current.comment).toBe("analysis");
    expect(client.result).toHaveBeenCalledTimes(1);
    expect(records.unsaved).toBe(true);
  });

  it("waits for final result application before finishing and unlocking", async () => {
    const { manager, records, status, result, finish } = fixture();
    await manager.start(settings);
    status.state = "completed";
    result.nodes[0].comment = "final";
    await vi.advanceTimersByTimeAsync(500);
    expect(finish).toHaveBeenCalledOnce();
    expect(records.analysisLocked).toBe(false);
    records.changePly(1);
    expect(records.record.current.comment).toBe("final");
    expect(manager.hasRetainedJob).toBe(false);
    const recovered = loadRecordForWebApp()!;
    recovered.goto(1);
    expect(recovered.current.comment).toBe("final");
    await vi.advanceTimersByTimeAsync(1000);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("keeps the document locked until cancellation is confirmed", async () => {
    const { manager, records, client, status } = fixture();
    await manager.start(settings);
    client.cancel.mockImplementation(async () => ({
      ...status,
      requestId: client.create.mock.calls[0][0].requestId,
      state: "cancelling",
    }));
    manager.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(records.analysisLocked).toBe(true);
    expect(manager.isCancelling).toBe(true);
    status.state = "cancelled";
    await vi.advanceTimersByTimeAsync(500);
    expect(records.analysisLocked).toBe(false);
  });

  it("recovers a lost creation response by request ID without a second job", async () => {
    const { manager, client, acceptRequest } = fixture();
    client.create.mockImplementationOnce(async (input) => {
      acceptRequest(input);
      throw new TypeError("offline");
    });
    await manager.start(settings);
    expect(manager.reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.byRequest).toHaveBeenCalledOnce();
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(manager.reconnecting).toBe(false);
  });

  it("retries transport failures without cancelling server work", async () => {
    const { manager, client } = fixture();
    await manager.start(settings);
    client.status.mockRejectedValueOnce(new TypeError("offline"));
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.reconnecting).toBe(true);
    expect(client.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.reconnecting).toBe(false);
  });

  it("uses the existing short toast once per synchronization outage", async () => {
    const { manager, client, result } = fixture();
    await manager.start(settings);
    expect(useToastStore().toasts).toHaveLength(0);
    client.status.mockRejectedValueOnce(new TypeError("offline"));
    client.result.mockRejectedValueOnce(new TypeError("offline"));
    await vi.advanceTimersByTimeAsync(500);
    expect(useToastStore().toasts).toMatchObject([
      { type: "warning", message: t.connectionLostRetrying, count: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useToastStore().toasts).toMatchObject([{ type: "warning", count: 1 }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(useToastStore().toasts).toMatchObject([
      { type: "success", message: t.reconnected, count: 1 },
    ]);
    expect(manager.reconnecting).toBe(false);
    expect(result.revision).toBeGreaterThan(0);
  });

  it("honors the advertised interval after every successful synchronization", async () => {
    const { manager, client } = fixture();
    client.capabilities.mockResolvedValue({ ...(await client.capabilities()), pollMs: 2000 });
    await manager.start(settings);
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.status).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1999);
    expect(client.status).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.status).toHaveBeenCalledTimes(2);
  });

  it.each(["status", "result", "cancel"] as const)(
    "retries a rate-limited %s request without releasing the document or job",
    async (endpoint) => {
      const { manager, records, client, error } = fixture();
      await manager.start(settings);
      client[endpoint].mockRejectedValueOnce(new ApiResponseError(429, "rate limited"));
      if (endpoint === "cancel") manager.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(manager.isActive).toBe(true);
      expect(records.analysisLocked).toBe(true);
      expect(manager.hasRetainedJob).toBe(true);
      expect(manager.reconnecting).toBe(true);
      expect(error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(manager.reconnecting).toBe(false);
      expect(client.create).toHaveBeenCalledTimes(1);
      if (endpoint === "cancel") {
        expect(client.cancel).toHaveBeenCalledTimes(2);
        expect(records.analysisLocked).toBe(false);
      } else {
        expect(client.result).toHaveBeenCalled();
        expect(client.result.mock.calls.at(-1)?.[1]).toBe(0);
      }
    },
  );

  it("honors Retry-After even when cancellation is requested while waiting", async () => {
    const { manager, records, client, response, error } = fixture();
    const http = createAnalysisJobsClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }),
    );
    await manager.start(settings);
    client.status.mockImplementationOnce(() => http.status("job"));
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.reconnecting).toBe(true);
    client.cancel.mockImplementationOnce(async () => ({ ...response(), state: "cancelling" }));
    manager.close();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(client.status).toHaveBeenCalledOnce();
    expect(client.cancel).not.toHaveBeenCalled();
    expect(records.analysisLocked).toBe(true);
    expect(manager.isCancelling).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.status).toHaveBeenCalledTimes(2);
    expect(client.cancel).toHaveBeenCalledOnce();
    expect(manager.reconnecting).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the applied revision when a later result request is rate limited", async () => {
    const { manager, records, client, status, result } = fixture();
    await manager.start(settings);
    await vi.advanceTimersByTimeAsync(500);
    status.resultRevision = 2;
    result.revision = 2;
    result.nodes[0] = { ...result.nodes[0], revision: 2, comment: "updated" };
    client.result.mockRejectedValueOnce(new ApiResponseError(429, "rate limited"));
    await vi.advanceTimersByTimeAsync(500);
    records.changePly(1);
    expect(records.record.current.comment).toBe("analysis");
    expect(records.analysisLocked).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(records.record.current.comment).toBe("updated");
    expect(client.result.mock.calls).toEqual([
      ["job", 0],
      ["job", 1],
      ["job", 1],
    ]);
  });

  it.each(["0", "invalid"])(
    "does not let cancellation bypass backoff with Retry-After %j",
    async (retryAfter) => {
      const { manager, records, client } = fixture();
      const http = createAnalysisJobsClient();
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": retryAfter } }),
      );
      await manager.start(settings);
      client.status.mockImplementationOnce(() => http.status("job"));
      await vi.advanceTimersByTimeAsync(500);
      manager.close();
      await vi.advanceTimersByTimeAsync(999);
      expect(client.status).toHaveBeenCalledOnce();
      expect(client.cancel).not.toHaveBeenCalled();
      expect(records.analysisLocked).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.cancel).toHaveBeenCalledOnce();
      expect(records.analysisLocked).toBe(false);
    },
  );

  it("keeps a rate-limited creation pending and retries the same request ID", async () => {
    const { manager, records, client, acceptRequest } = fixture();
    const http = createAnalysisJobsClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "30" } }),
    );
    client.create.mockImplementationOnce(async (request) => {
      acceptRequest(request);
      return http.create(request);
    });
    client.byRequest.mockRejectedValueOnce(new ApiResponseError(410, "not created"));
    await manager.start(settings);
    expect(records.analysisLocked).toBe(true);
    expect(manager.reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.byRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.create.mock.calls[1][0]).toEqual(client.create.mock.calls[0][0]);
    expect(manager.reconnecting).toBe(false);
  });

  it("stays below the real shared rate limit across consecutive fifteen-minute windows", async () => {
    const { manager, client, response, status, result, error } = fixture();
    const app = new Hono();
    app.use("*", createRateLimiter());
    app.get("/api/analysis-jobs/job", (c) => {
      status.resultRevision++;
      return c.json(response());
    });
    app.get("/api/analysis-jobs/job/result", (c) => {
      result.revision = status.resultRevision;
      result.nodes[0].revision = result.revision;
      return c.json(result);
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => app.request(input, init));
    const http = createAnalysisJobsClient();
    const capabilities = new AnalysisJobManager().capabilities();
    client.capabilities.mockResolvedValue({ ...capabilities, serverInstanceId: "server" });
    client.status.mockImplementation(() => http.status("job"));
    client.result.mockImplementation((_id, revision) => http.result("job", revision));
    await manager.start(settings);
    for (let window = 0; window < 2; window++) {
      fetch.mockClear();
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(manager.isActive).toBe(true);
      expect(manager.reconnecting).toBe(false);
      expect(error).not.toHaveBeenCalled();
      expect(fetch.mock.calls.length).toBe(1800);
    }
  });

  it("does not recreate a job after expiry or restart", async () => {
    const { manager, records, client, error } = fixture();
    await manager.start(settings);
    client.status.mockRejectedValue(new ApiResponseError(410, "expired"));
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.isActive).toBe(false);
    expect(manager.hasRetainedJob).toBe(false);
    expect(records.analysisLocked).toBe(false);
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledOnce();
  });

  it("rejects results from a different job and retains the recovery reference", async () => {
    const { manager, records, result, error } = fixture();
    await manager.start(settings);
    result.jobId = "another";
    await vi.advanceTimersByTimeAsync(500);
    expect(error).toHaveBeenCalledOnce();
    expect(manager.hasRetainedJob).toBe(true);
    expect(records.analysisLocked).toBe(false);
    records.changePly(1);
    expect(records.record.current.comment).toBe("");
  });

  it("does not change the browsing position after manual navigation", async () => {
    const { manager, records } = fixture();
    await manager.start(settings);
    records.changePly(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(records.record.current.ply).toBe(1);
    expect(records.record.current.comment).toBe("analysis");
  });

  it("stops following even when manual navigation returns to the same node", async () => {
    const { manager, records, status } = fixture();
    await manager.start(settings);
    await vi.advanceTimersByTimeAsync(500);
    records.changePly(1);
    records.changePly(0);
    status.current = {
      nodeId: "n2",
      searchId: 2,
      position: "position startpos moves 7g7f 3c3d",
      infos: [],
    };
    await vi.advanceTimersByTimeAsync(500);
    expect(records.record.current.ply).toBe(0);
  });

  it("does not overlap polling requests", async () => {
    const { manager, client, response } = fixture();
    await manager.start(settings);
    let respond!: (status: AnalysisJobStatus) => void;
    client.status.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.status).toHaveBeenCalledOnce();
    respond(response());
    await vi.advanceTimersByTimeAsync(500);
    expect(client.status).toHaveBeenCalledTimes(2);
  });

  it("works through the same deep reactive proxy used by the store", async () => {
    const { records, client, status } = fixture();
    const proxied = reactive({ manager: new AnalysisManager(records, client), records });
    await proxied.manager.start(settings);
    status.state = "completed";
    await vi.advanceTimersByTimeAsync(500);
    proxied.records.changePly(1);
    expect(proxied.records.record.current.comment).toBe("analysis");
    expect(proxied.records.analysisLocked).toBe(false);
  });

  it("freezes the selected path before a delayed capabilities response", async () => {
    const { manager, records, client } = fixture();
    const original = snapshotRecord(records.record);
    let respond!: () => void;
    const capabilities = await client.capabilities();
    client.capabilities.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          respond = () => resolve(capabilities);
        }),
    );
    const starting = manager.start(settings);
    records.changePly(0);
    respond();
    await starting;
    expect(client.create.mock.calls[0][0].source).toEqual(JSON.parse(JSON.stringify(original)));
  });

  it("rejects result application after a bypassed local edit", async () => {
    const { manager, records, error } = fixture();
    await manager.start(settings);
    (records.record.current as Record["current"]).comment = "external edit";
    await vi.advanceTimersByTimeAsync(500);
    expect(error).toHaveBeenCalledOnce();
    expect(records.record.current.comment).toBe("external edit");
    expect(manager.hasRetainedJob).toBe(true);
  });

  it("retries full recovery after a network outage without applying to an unverified record", async () => {
    const { manager, client, status } = fixture();
    await manager.start(settings);
    vi.clearAllTimers();
    status.state = "completed";
    const records = new RecordManager();
    records.updateComment("local work");
    client.source.mockRejectedValueOnce(new TypeError("offline"));
    const resumed = new AnalysisManager(records, client);
    const confirm = vi.fn(async () => false);
    expect(await resumed.resume(confirm)).toBe(false);
    expect(records.analysisLocked).toBe(true);
    expect(resumed.reconnecting).toBe(true);
    resumed.close();
    expect(client.result).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(confirm).toHaveBeenCalledOnce();
    expect(records.record.current.comment).toBe("local work");
    expect(records.analysisLocked).toBe(false);
  });

  it("restores a completed job after reload even if the create response was never received", async () => {
    const { manager, client, acceptRequest, status, source } = fixture();
    client.create.mockImplementationOnce(async (input) => {
      acceptRequest(input);
      throw new TypeError("lost response");
    });
    await manager.start(settings);
    vi.clearAllTimers();
    status.state = "completed";
    const records = new RecordManager(restoreRecord(source).record);
    const resumed = new AnalysisManager(records, client);
    const confirm = vi.fn(async () => true);
    expect(await resumed.resume(confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    records.changePly(1);
    expect(records.record.current.comment).toBe("analysis");
    expect(resumed.hasRetainedJob).toBe(false);
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it("announces reconnection after replacing a confirmed different record during recovery", async () => {
    const { manager, client } = fixture();
    await manager.start(settings);
    vi.clearAllTimers();
    const records = new RecordManager();
    records.updateComment("Different local work");
    client.source.mockRejectedValueOnce(new TypeError("offline"));
    const resumed = new AnalysisManager(records, client);
    const confirm = vi.fn(async () => true);
    await resumed.resume(confirm);
    expect(useToastStore().toasts).toMatchObject([
      { type: "warning", message: t.connectionLostRetrying },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(confirm).toHaveBeenCalledOnce();
    expect(useToastStore().toasts).toMatchObject([{ type: "success", message: t.reconnected }]);
    resumed.close();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("recovers an unchanged record through the source decoder without replacement confirmation", async () => {
    const { manager, records, client, source, status } = fixture();
    (records.record.current as Record["current"]).customData = {
      researchInfo: { usi: records.record.usi, depth: 20, score: 0, lowerBound: false },
    };
    Object.assign(source, snapshotRecord(records.record));
    await manager.start(settings);
    vi.clearAllTimers();
    status.state = "completed";
    const http = createAnalysisJobsClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(source)));
    client.source.mockImplementation(() => http.source("job"));
    const resumedRecords = new RecordManager(restoreRecord(source).record);
    const resumed = new AnalysisManager(resumedRecords, client);
    const confirm = vi.fn(async () => false);
    expect(await resumed.resume(confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    resumedRecords.changePly(1);
    expect(resumedRecords.record.current.comment).toBe("analysis");
  });

  it("recovers an unchanged projected result despite search info key order differences", async () => {
    const { manager, records, client, result, status } = fixture();
    result.nodes[0].researchInfo = {
      depth: 20,
      score: 0,
      usi: "position startpos moves 7g7f",
    };
    await manager.start(settings);
    await vi.advanceTimersByTimeAsync(500);
    vi.clearAllTimers();
    status.state = "completed";
    const local = snapshotRecord(records.record);
    local.nodes[1].customData!.researchInfo = {
      usi: "position startpos moves 7g7f",
      score: 0,
      depth: 20,
    };
    const resumedRecords = new RecordManager(restoreRecord(local).record);
    const resumed = new AnalysisManager(resumedRecords, client);
    const confirm = vi.fn(async () => false);
    expect(await resumed.resume(confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(resumed.hasRetainedJob).toBe(false);
  });

  it("respects the advertised interval after reload and keeps rate-limited recovery locked", async () => {
    const { manager, client, source } = fixture();
    const http = createAnalysisJobsClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "30" } }),
    );
    await manager.start(settings);
    vi.clearAllTimers();
    client.capabilities.mockResolvedValue({ ...(await client.capabilities()), pollMs: 2000 });
    client.result.mockImplementationOnce(() => http.result("job", 0));
    const records = new RecordManager(restoreRecord(source).record);
    const resumed = new AnalysisManager(records, client);
    const confirm = vi.fn(async () => false);
    expect(await resumed.resume(confirm)).toBe(false);
    expect(records.analysisLocked).toBe(true);
    expect(resumed.reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.result).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(resumed.reconnecting).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    const polls = client.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1999);
    expect(client.status).toHaveBeenCalledTimes(polls);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.status).toHaveBeenCalledTimes(polls + 1);
    resumed.close();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("never overwrites a different unsaved record without confirmation", async () => {
    const { manager, client, status } = fixture();
    await manager.start(settings);
    vi.clearAllTimers();
    status.state = "completed";
    const records = new RecordManager();
    records.updateComment("local work");
    const resumed = new AnalysisManager(records, client);
    expect(await resumed.resume(async () => false)).toBe(false);
    expect(records.record.current.comment).toBe("local work");
    expect(resumed.hasRetainedJob).toBe(true);
    expect(await resumed.resume(async () => true)).toBe(true);
    records.changePly(1);
    expect(records.record.current.comment).toBe("analysis");
  });

  it("keeps another tab's recovery reference when a new start is rejected", async () => {
    const { manager, client } = fixture();
    // Another tab wins creation after our startup checks.
    const other = {
      requestId: "other",
      serverInstanceId: "server",
      jobId: "job-other",
    };
    client.create.mockImplementationOnce(async () => {
      localStorage.setItem("shogihome-analysis-job", JSON.stringify(other));
      throw new ApiResponseError(503, "capacity");
    });
    await expect(manager.start(settings)).rejects.toThrow("capacity");
    expect(localStorage.getItem("shogihome-analysis-job")).toBe(JSON.stringify(other));
    const requestId = client.create.mock.calls[0][0].requestId;
    expect(localStorage.getItem(`shogihome-analysis-job:${requestId}`)).toBeNull();
    expect(manager.hasRetainedJob).toBe(true);
  });

  it("keeps another tab's per-request recovery reference when a new start is rejected", async () => {
    const { manager, client } = fixture();
    const other = {
      requestId: "other",
      serverInstanceId: "server",
      jobId: "job-other",
    };
    client.create.mockImplementationOnce(async () => {
      localStorage.setItem("shogihome-analysis-job:other", JSON.stringify(other));
      throw new ApiResponseError(503, "capacity");
    });
    await expect(manager.start(settings)).rejects.toThrow("capacity");
    expect(localStorage.getItem("shogihome-analysis-job:other")).toBe(JSON.stringify(other));
  });

  it.each(["legacy", "per-request"] as const)(
    "recovers another tab's %s reference after a rejected start without reloading",
    async (storage) => {
      const { manager, client, source, status } = fixture();
      const records = new RecordManager(restoreRecord(source).record);
      const resumed = new AnalysisManager(records, client);
      await manager.start(settings);
      vi.clearAllTimers();
      const requestId = client.create.mock.calls[0][0].requestId;
      const key = `shogihome-analysis-job:${requestId}`;
      if (storage === "legacy") {
        localStorage.setItem("shogihome-analysis-job", localStorage.getItem(key)!);
        localStorage.removeItem(key);
      }
      try {
        await expect(resumed.start(settings)).rejects.toThrow();
        expect(resumed.isActive).toBe(false);
        expect(resumed.hasRetainedJob).toBe(true);
        expect(records.analysisLocked).toBe(false);
        expect(client.create).toHaveBeenCalledOnce();
        const confirm = vi.fn(async () => true);
        expect(await resumed.resume(confirm)).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
        expect(resumed.isActive).toBe(true);
        expect(records.analysisLocked).toBe(true);
        expect(client.status).toHaveBeenCalledWith("job");
        expect(client.result).toHaveBeenCalledWith("job", 0);
        expect(client.create).toHaveBeenCalledOnce();
        expect(client.cancel).not.toHaveBeenCalled();
        records.changePly(1);
        expect(records.record.current.comment).toBe("analysis");
        status.state = "completed";
        await vi.advanceTimersByTimeAsync(500);
        expect(resumed.isActive).toBe(false);
        expect(records.analysisLocked).toBe(false);
        expect(resumed.hasRetainedJob).toBe(false);
      } finally {
        resumed.close();
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it.each(["legacy", "per-request"] as const)(
    "starts a new analysis after another tab completes a declined %s recovery",
    async (storage) => {
      const { manager, client, source, status } = fixture();
      await manager.start(settings);
      const requestId = client.create.mock.calls[0][0].requestId;
      const key = `shogihome-analysis-job:${requestId}`;
      if (storage === "legacy") {
        localStorage.setItem("shogihome-analysis-job", localStorage.getItem(key)!);
        localStorage.removeItem(key);
      }
      const records = new RecordManager(restoreRecord(source).record);
      records.updateComment("local work");
      const other = new AnalysisManager(records, client);
      try {
        expect(await other.resume(async () => false)).toBe(false);
        expect(other.hasRetainedJob).toBe(true);
        expect(records.analysisLocked).toBe(false);
        status.state = "completed";
        await vi.advanceTimersByTimeAsync(500);
        expect(manager.isActive).toBe(false);
        expect(other.hasRetainedJob).toBe(false);
        expect(records.record.current.comment).toBe("local work");

        await expect(other.start(settings)).resolves.toBeUndefined();
        expect(other.isActive).toBe(true);
        expect(records.analysisLocked).toBe(true);
        expect(client.create).toHaveBeenCalledTimes(2);
        expect(client.create.mock.calls[1][0].requestId).not.toBe(requestId);
      } finally {
        other.close();
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it("does not recover a cached reference removed by another tab", async () => {
    const { manager, client, source } = fixture();
    await manager.start(settings);
    vi.clearAllTimers();
    const resumed = new AnalysisManager(new RecordManager(restoreRecord(source).record), client);
    const requestId = client.create.mock.calls[0][0].requestId;
    localStorage.removeItem(`shogihome-analysis-job:${requestId}`);
    try {
      expect(resumed.hasRetainedJob).toBe(false);
      expect(await resumed.resume(async () => true)).toBe(false);
      expect(resumed.isActive).toBe(false);
      expect(client.status).not.toHaveBeenCalled();
    } finally {
      resumed.close();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("keeps recovery linkage when browser record persistence fails", async () => {
    const { manager, client, status, error } = fixture();
    await manager.start(settings);
    const requestId = client.create.mock.calls[0][0].requestId;
    status.state = "completed";
    const original = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === "webapp:jkf") throw new DOMException("Storage full", "QuotaExceededError");
      original.call(this, key, value);
    });
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(manager.isActive).toBe(false);
      expect(manager.hasRetainedJob).toBe(true);
      expect(localStorage.getItem(`shogihome-analysis-job:${requestId}`)).not.toBeNull();
      expect(error).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });

  it("does not replace an unsaved record if its backup fails", async () => {
    const { manager, client, status } = fixture();
    await manager.start(settings);
    vi.clearAllTimers();
    status.state = "completed";
    const records = new RecordManager();
    records.updateComment("local work");
    const resumed = new AnalysisManager(records, client);
    vi.mocked(api.saveRecordFileBackup).mockRejectedValueOnce(new Error("Backup failed"));
    await expect(resumed.resume(async () => true)).rejects.toThrow("Backup failed");
    expect(records.record.current.comment).toBe("local work");
    expect(resumed.hasRetainedJob).toBe(true);
    expect(records.analysisLocked).toBe(false);
  });
});
