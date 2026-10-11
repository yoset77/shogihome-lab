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
import { loadRecordForWebApp, flushRecordForWebApp } from "@/renderer/store/webapp";
import api from "@/renderer/ipc/api";
import { useToastStore } from "@/renderer/store/toast";
import { t } from "@/common/i18n";
import { JobAttachment } from "@/server/jobs/attachment";
import type { JobSummary } from "@/common/jobs/types";

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
  let attachment = new JobAttachment();
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
    cancelOutcome: vi.fn<AnalysisJobsClient["cancelOutcome"]>(async () => ({ state: "unknown" })),
    list: vi.fn(async () => []),
    attach: vi.fn<AnalysisJobsClient["attach"]>(async (_id, binding) => {
      const result = attachment.claim(binding);
      status.attachment = attachment.status();
      return result;
    }),
    detach: vi.fn<AnalysisJobsClient["detach"]>(async (_id, binding) => {
      attachment.release(binding);
      status.attachment = attachment.status();
      return response();
    }),
    capabilities: vi.fn(async () => ({
      serverInstanceId: "server",
      pollMs: 500,
      maxInputBytes: 10 * 1024 * 1024,
      maxNodes: 10_000,
    })),
    create: vi.fn<AnalysisJobsClient["create"]>(async (input) => {
      request = input;
      attachment = new JobAttachment();
      status.attachment = attachment.status();
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
    summary: (): JobSummary => ({
      kind: "analysis",
      id: "job",
      requestId: request!.requestId,
      serverInstanceId: "server",
      createdAt: 1000,
      state: status.state,
      engines: ["test"],
      completed: 1,
      total: 3,
      attachment: attachment.status(),
    }),
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
    sessionStorage.clear();
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

  it("keeps startup pending until the first analysis position is applied", async () => {
    const { manager, records, status } = fixture();
    await manager.start(settings);
    expect(manager.isStarting).toBe(true);
    expect(records.record.current.ply).toBe(2);
    const current = status.current;
    status.current = null;
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.isStarting).toBe(true);
    expect(records.record.current.ply).toBe(2);
    status.current = { ...current!, infos: [] };
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.isStarting).toBe(false);
    expect(records.record.current.ply).toBe(0);
  });

  it("keeps startup pending when the first target is known but its search is still preparing", async () => {
    const { manager, status } = fixture();
    status.state = "preparing";
    await manager.start(settings);
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.isStarting).toBe(true);
    status.state = "running";
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.isStarting).toBe(false);
    status.state = "preparing";
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.isStarting).toBe(false);
  });

  it.each(["failed", "completed", "cancelled", "finishing", "cancelling"] as const)(
    "ends the startup wait on %s even without a first analysis position",
    async (state) => {
      const { manager, status } = fixture();
      status.current = null;
      status.resultRevision = 0;
      await manager.start(settings);
      expect(manager.isStarting).toBe(true);
      status.state = state;
      await vi.advanceTimersByTimeAsync(500);
      expect(manager.isStarting).toBe(false);
    },
  );

  it.each(["close", "detach", "suspend"] as const)(
    "ends the startup wait on %s",
    async (action) => {
      const { manager } = fixture();
      await manager.start(settings);
      expect(manager.isStarting).toBe(true);
      manager[action]();
      expect(manager.isStarting).toBe(false);
    },
  );

  it("ends the startup wait even when rejected creation linkage cannot be removed", async () => {
    const { manager, client } = fixture();
    client.create.mockRejectedValueOnce(new ApiResponseError(400, "Invalid request"));
    const storage = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    try {
      await expect(manager.start(settings)).rejects.toThrow("Storage unavailable");
      expect(manager.isStarting).toBe(false);
    } finally {
      storage.mockRestore();
    }
  });

  it("ends the startup wait on polling failure while retaining the job and record lock", async () => {
    const { manager, records, client, status } = fixture();
    status.state = "preparing";
    status.current = null;
    status.resultRevision = 0;
    await manager.start(settings);
    client.status.mockRejectedValueOnce(new TypeError("Offline"));
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.isStarting).toBe(false);
    expect(manager.reconnecting).toBe(true);
    expect(records.analysisLocked).toBe(true);
    expect(manager.hasRetainedJob).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.status?.state).toBe("preparing");
    expect(manager.isStarting).toBe(false);
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

  it("starts in the background without attachment intent or result application", async () => {
    const { manager, records, client } = fixture();
    const original = snapshotRecord(records.record);
    await manager.start(settings, true);
    expect(manager.isActive).toBe(false);
    expect(manager.isStarting).toBe(false);
    expect(records.analysisLocked).toBe(false);
    expect(sessionStorage.getItem("shogihome-job-attachment:analysis")).toBeNull();
    expect(client.attach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.result).not.toHaveBeenCalled();
    expect(snapshotRecord(records.record)).toEqual(original);
  });

  it("detaches without cancelling and ignores an in-flight result", async () => {
    const { manager, records, client, result } = fixture();
    await manager.start(settings);
    let respond!: () => void;
    client.result.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = () => resolve(result);
        }),
    );
    await vi.advanceTimersByTimeAsync(500);
    manager.detach();
    records.updateComment("Local work after detaching");
    respond();
    await vi.advanceTimersByTimeAsync(2000);
    expect(records.record.current.comment).toBe("Local work after detaching");
    expect(records.analysisLocked).toBe(false);
    expect(client.cancel).not.toHaveBeenCalled();
    expect(manager.hasRetainedJob).toBe(false);
    const resumed = new AnalysisManager(records, client);
    expect(await resumed.resume(async () => true)).toBe(false);
  });

  it("opens a detached job on a device without browser linkage", async () => {
    const value = fixture();
    await value.manager.start(settings, true);
    sessionStorage.clear();
    localStorage.clear();
    const records = new RecordManager();
    records.updateComment("Unsaved work");
    const other = new AnalysisManager(records, value.client);
    const confirm = vi.fn(async () => true);
    expect(await other.attach(value.summary(), confirm, async () => true)).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(records.analysisLocked).toBe(true);
    records.changePly(1);
    expect(records.record.current.comment).toBe("analysis");
    other.detach();
  });

  it("retrieves completed background results without any starting-device storage", async () => {
    const value = fixture();
    await value.manager.start(settings, true);
    value.status.state = "completed";
    localStorage.clear();
    sessionStorage.clear();
    const records = new RecordManager();
    const other = new AnalysisManager(records, value.client);
    expect(
      await other.attach(
        value.summary(),
        async () => true,
        async () => true,
      ),
    ).toBe(true);
    expect(other.isActive).toBe(false);
    expect(records.analysisLocked).toBe(false);
    records.changePly(1);
    expect(records.record.current.comment).toBe("analysis");
    expect(value.client.create).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("shogihome-job-attachment:analysis")).toBeNull();
  });

  it("retries a delivered attachment with the same owner after its response is lost", async () => {
    const value = fixture();
    await value.manager.start(settings, true);
    const claim = value.client.attach.getMockImplementation()!;
    value.client.attach.mockImplementationOnce(async (id, request) => {
      await claim(id, request);
      throw new TypeError("Attachment response lost");
    });
    expect(
      await value.manager.attach(
        value.summary(),
        async () => true,
        async () => true,
      ),
    ).toBe(true);
    expect(value.manager.isActive).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.client.attach).toHaveBeenCalledTimes(2);
    expect(value.client.attach.mock.calls[0][1]).toEqual(value.client.attach.mock.calls[1][1]);
    expect(value.manager.reconnecting).toBe(false);
    value.records.changePly(1);
    expect(value.records.record.current.comment).toBe("analysis");
  });

  it("does not steal attachment when record replacement is declined", async () => {
    const value = fixture();
    await value.manager.start(settings);
    const records = new RecordManager();
    records.updateComment("Keep this record");
    const other = new AnalysisManager(records, value.client);
    const claims = value.client.attach.mock.calls.length;
    expect(
      await other.attach(
        value.summary(),
        async () => false,
        async () => true,
      ),
    ).toBe(false);
    expect(value.client.attach).toHaveBeenCalledTimes(claims);
    expect(value.manager.isActive).toBe(true);
    expect(records.record.current.comment).toBe("Keep this record");
    expect(records.analysisLocked).toBe(false);
  });

  it("clears automatic recovery after ownership transfer without reclaiming it", async () => {
    const value = fixture();
    await value.manager.start(settings);
    await value.client.attach("job", {
      ownerId: "another-device",
      epoch: value.summary().attachment.epoch,
      takeover: true,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(value.manager.isActive).toBe(false);
    expect(value.records.analysisLocked).toBe(false);
    expect(sessionStorage.getItem("shogihome-job-attachment:analysis")).toBeNull();
    const claims = value.client.attach.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(value.client.attach).toHaveBeenCalledTimes(claims);
  });

  it("releases the edit lock when explicit attachment fails to load its source", async () => {
    const value = fixture();
    await value.manager.start(settings, true);
    value.client.source.mockRejectedValueOnce(new Error("Source unavailable"));
    await expect(
      value.manager.attach(
        value.summary(),
        async () => true,
        async () => true,
      ),
    ).rejects.toThrow("Source unavailable");
    expect(value.records.analysisLocked).toBe(false);
    expect(value.manager.isActive).toBe(false);
  });

  it("does not replace local work after detaching during attachment backup", async () => {
    const value = fixture();
    await value.manager.start(settings, true);
    value.records.updateComment("Unsaved work");
    let complete!: () => void;
    vi.mocked(api.saveRecordFileBackup).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve(undefined);
        }),
    );
    const attaching = value.manager.attach(
      value.summary(),
      async () => true,
      async () => true,
    );
    await vi.advanceTimersByTimeAsync(0);
    value.manager.detach();
    value.records.updateComment("New local work");
    complete();
    expect(await attaching).toBe(false);
    expect(value.records.record.current.comment).toBe("New local work");
    expect(value.client.attach).not.toHaveBeenCalled();
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

  it("does not cancel later when durable cancellation recording fails", async () => {
    const value = fixture();
    await value.manager.start(settings);
    const original = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      content,
    ) {
      if (this === localStorage && key.startsWith("shogihome-job-journal:"))
        throw new Error("Storage full");
      original.call(this, key, content);
    });
    value.manager.close();
    write.mockRestore();
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.client.cancel).not.toHaveBeenCalled();
    expect(value.error).toHaveBeenCalledOnce();
    expect(value.manager.isCancelling).toBe(false);
  });

  it("resumes the same-tab record after partial analysis without a routine dialog", async () => {
    const value = fixture();
    await value.manager.start(settings);
    await vi.advanceTimersByTimeAsync(500);
    flushRecordForWebApp(value.records.record);
    value.manager.suspend();
    const records = new RecordManager(loadRecordForWebApp());
    const reloaded = new AnalysisManager(records, value.client);
    const confirm = vi.fn(async () => true);
    expect(await reloaded.resume(confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    reloaded.detach();
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
    expect(client.result.mock.calls.map(([id, revision]) => [id, revision])).toEqual([
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
    expect(proxied.manager.isStarting).toBe(true);
    status.state = "completed";
    await vi.advanceTimersByTimeAsync(500);
    expect(proxied.manager.isStarting).toBe(false);
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
    expect(manager.hasRetainedJob).toBe(false);
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
    "migrates a %s reference without turning it into attachment intent",
    async (format) => {
      const value = fixture();
      await value.manager.start(settings, true);
      const reference = {
        requestId: value.response().requestId,
        serverInstanceId: "server",
        jobId: "job",
      };
      const key =
        format === "legacy"
          ? "shogihome-analysis-job"
          : `shogihome-analysis-job:${reference.requestId}`;
      localStorage.setItem(key, JSON.stringify(reference));
      const records = new RecordManager();
      records.updateComment("Local work");
      const other = new AnalysisManager(records, value.client);
      expect(await other.resume(async () => true)).toBe(false);
      await other.reconcilePending();
      expect(localStorage.getItem(key)).toBeNull();
      expect(other.hasRetainedJob).toBe(false);
      expect(value.client.attach).not.toHaveBeenCalled();
      expect(value.client.cancel).not.toHaveBeenCalled();
      expect(records.record.current.comment).toBe("Local work");
    },
  );

  it.each(["legacy", "per-request"] as const)(
    "does not automatically replay a %s cancellation from another owner",
    async (format) => {
      const value = fixture();
      await value.manager.start(settings, true);
      const reference = {
        requestId: value.response().requestId,
        serverInstanceId: "server",
        jobId: "job",
        cancelRequested: true,
      };
      const key =
        format === "legacy"
          ? "shogihome-analysis-job"
          : `shogihome-analysis-job:${reference.requestId}`;
      localStorage.setItem(key, JSON.stringify(reference));
      const other = new AnalysisManager(new RecordManager(), value.client);
      await other.reconcilePending();
      expect(await other.resume(async () => true)).toBe(false);
      expect(value.client.cancel).not.toHaveBeenCalled();
      expect(
        Object.keys(localStorage).some((key) => key.startsWith("shogihome-job-journal:analysis:")),
      ).toBe(true);
    },
  );

  it("does not recover after this tab's attachment intent is removed", async () => {
    const { manager, client, source } = fixture();
    await manager.start(settings);
    vi.clearAllTimers();
    const resumed = new AnalysisManager(new RecordManager(restoreRecord(source).record), client);
    sessionStorage.removeItem("shogihome-job-attachment:analysis");
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
    const { manager, status, error } = fixture();
    await manager.start(settings);
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
      expect(sessionStorage.getItem("shogihome-job-attachment:analysis")).not.toBeNull();
      expect(error).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });

  it("reports attachment cleanup storage failures instead of silently completing", async () => {
    const value = fixture();
    await value.manager.start(settings);
    value.status.state = "completed";
    const original = Storage.prototype.removeItem;
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key,
    ) {
      if (this === sessionStorage && key === "shogihome-job-attachment:analysis")
        throw new Error("Storage unavailable");
      original.call(this, key);
    });
    await vi.advanceTimersByTimeAsync(500);
    remove.mockRestore();
    expect(value.error).toHaveBeenCalledOnce();
    expect(value.finish).not.toHaveBeenCalled();
    expect(value.records.analysisLocked).toBe(false);
    expect(sessionStorage.getItem("shogihome-job-attachment:analysis")).not.toBeNull();
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
