// @vitest-environment node
import net from "node:net";
import readline from "node:readline";
import { Hono } from "hono";
import { Record } from "tsshogi";
import { AnalysisJobManager } from "@/server/analysis/jobManager";
import { createAnalysisJobRoutes } from "@/server/routes/analysis_jobs";
import { handleError } from "@/server/errors";
import { saveAnalysisResults } from "@/server/database/sqlite";
import { engineConfigCache } from "@/server/engine/list";
import type { AppEnv } from "@/server/hono";
import { requestFor } from "./helpers/analysis";

const wrapperConfig = vi.hoisted(() => ({ port: 0 }));
vi.mock("@/server/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/config")>()),
  REMOTE_ENGINE_HOST: "127.0.0.1",
  get REMOTE_ENGINE_PORT() {
    return wrapperConfig.port;
  },
}));
vi.mock("@/server/database/sqlite", () => ({ saveAnalysisResults: vi.fn() }));

describe("HTTP analysis through the real TCP/USI session", () => {
  const sockets = new Set<net.Socket>();
  let wrapper: net.Server;
  let commands: string[];
  let manager: AnalysisJobManager;
  let app: Hono<AppEnv>;
  let mode: "normal" | "disconnect" | "startup" = "normal";
  let configuredMultiPV = 1;

  beforeAll(async () => {
    wrapper = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const lines = readline.createInterface({ input: socket });
      let position = "position startpos";
      let multiPV = configuredMultiPV;
      lines.on("line", (line) => {
        commands.push(line);
        if (line === "list") {
          socket.end(
            JSON.stringify([
              {
                id: "test",
                name: "Server engine",
                type: ["research"],
                analysisDBGroupId: "group",
                analysisDBGroupName: "Group",
              },
            ]) + "\n",
          );
        } else if (line === "usi" && mode !== "startup") socket.write("usiok\n");
        else if (line === "isready") socket.write("readyok\n");
        else if (line.startsWith("setoption name MultiPV value "))
          multiPV = Number(line.split(" ").at(-1));
        else if (line.startsWith("position ")) position = line;
        else if (line === "go infinite") {
          if (mode === "disconnect") socket.destroy();
          else socket.write("info depth 50 score cp 10\n");
        } else if (line === "stop") {
          const record = Record.newByUSI(position) as Record;
          const pv = ["7g7f", "3c3d", "2g2f"][record.current.ply] ?? "2g2f";
          // The last info must be consumed before bestmove settles the search.
          const alternatives = record.current.ply === 1 ? ["8c8d", "5c5d"] : ["5g5f", "6g6f"];
          const infos = [`info multipv 1 depth 100 score cp 20 pv ${pv}`];
          for (let rank = 2; rank <= Math.min(multiPV, 3); rank++)
            infos.push(
              `info multipv ${rank} depth 100 score cp ${rank * 100} pv ${alternatives[rank - 2]}`,
            );
          socket.write(infos.join("\n") + `\nbestmove ${pv}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => wrapper.listen(0, "127.0.0.1", resolve));
    wrapperConfig.port = (wrapper.address() as net.AddressInfo).port;
  });

  beforeEach(() => {
    mode = "normal";
    configuredMultiPV = 1;
    commands = [];
    vi.mocked(saveAnalysisResults).mockClear();
    manager = new AnalysisJobManager();
    app = new Hono<AppEnv>().route("/api/analysis-jobs", createAnalysisJobRoutes(manager));
    app.onError(handleError);
  });
  afterEach(async () => {
    await manager.close();
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => wrapper.close(() => resolve()));
  });

  async function create(multiPV?: number, requestId = "request-1") {
    const request = requestFor(Record.newByUSI("position startpos moves 7g7f 3c3d") as Record);
    request.serverInstanceId = manager.serverInstanceId;
    request.requestId = requestId;
    request.options.perMoveCriteria.maxSeconds = 0.1;
    if (multiPV !== undefined) Object.assign(request.options, { overrideMultiPV: true, multiPV });
    const response = await app.request("/api/analysis-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(202);
    const status = await response.json();
    return { request, job: manager.get(status.jobId) };
  }

  it("finishes with no browser transport, recovers by request, and reuses the DB writer exactly once per search", async () => {
    const { job, request } = await create();
    await job.completion;
    expect(job.status()).toMatchObject({
      state: "completed",
      completedPositions: 3,
      engineName: "Server engine",
    });
    const status = await (
      await app.request(`/api/analysis-jobs/by-request/${request.requestId}`)
    ).json();
    expect(status.jobId).toBe(job.id);
    expect(commands.filter((command) => command === "go infinite")).toHaveLength(3);
    expect(commands.filter((command) => command === "stop")).toHaveLength(3);
    expect(commands.some((command) => command.startsWith("setoption name MultiPV"))).toBe(false);
    expect(job.result().nodes.every((node) => node.researchInfo?.depth === 100)).toBe(true);
    expect(vi.mocked(saveAnalysisResults)).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(saveAnalysisResults)
        .mock.calls.every((args) => args[2] === "group" && args[3] === "Group"),
    ).toBe(true);
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

  it("overrides configured MultiPV once before searching and saves every candidate through the existing writer", async () => {
    configuredMultiPV = 5;
    const { job } = await create(3);
    await job.completion;
    expect(job.status().state).toBe("completed");
    const command = "setoption name MultiPV value 3";
    expect(commands.filter((line) => line === command)).toHaveLength(1);
    expect(commands.indexOf(command)).toBeGreaterThan(commands.indexOf("isready"));
    expect(commands.indexOf(command)).toBeLessThan(commands.indexOf("usinewgame"));
    expect(commands.indexOf(command)).toBeLessThan(commands.indexOf("go infinite"));
    expect(saveAnalysisResults).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(saveAnalysisResults).mock.calls)
      expect([...call[4].keys()]).toEqual([1, 2, 3]);
    expect(
      job
        .result()
        .nodes.every((node) => node.researchInfo?.score === 20 || node.researchInfo?.score === -20),
    ).toBe(true);
    expect(job.result().nodes.some((node) => node.comment.includes("#評価値=200"))).toBe(false);
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

  it("inherits configured MultiPV without sending an override", async () => {
    configuredMultiPV = 3;
    const { job } = await create();
    await job.completion;
    expect(job.status().state).toBe("completed");
    expect(commands.some((command) => command.startsWith("setoption name MultiPV"))).toBe(false);
    for (const call of vi.mocked(saveAnalysisResults).mock.calls)
      expect([...call[4].keys()]).toEqual([1, 2, 3]);
  });

  it("does not carry an override into a later job", async () => {
    const first = await create(3);
    await first.job.completion;
    commands = [];
    vi.mocked(saveAnalysisResults).mockClear();
    const second = await create(undefined, "second-request");
    await second.job.completion;
    expect(second.job.status().state).toBe("completed");
    expect(commands.some((command) => command.startsWith("setoption name MultiPV"))).toBe(false);
    for (const call of vi.mocked(saveAnalysisResults).mock.calls)
      expect([...call[4].keys()]).toEqual([1]);
  });

  it("uses server-resolved DB policy even if discovery cache changes", async () => {
    const { job } = await create();
    await vi.waitFor(() => expect(commands).toContain("go infinite"));
    engineConfigCache.set("test", { id: "test", name: "Changed", skipAnalysisDB: true });
    await job.completion;
    expect(job.status().state).toBe("completed");
    expect(saveAnalysisResults).toHaveBeenCalled();
    expect(job.status().engineName).toBe("Server engine");
  });

  it("cleans up when the engine disconnects during a search", async () => {
    mode = "disconnect";
    const { job } = await create();
    await job.completion;
    expect(job.status()).toMatchObject({ state: "failed", error: "engine" });
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

  it("cancels during the USI handshake without issuing a search", async () => {
    mode = "startup";
    const { job } = await create();
    await vi.waitFor(() => expect(commands).toContain("usi"));
    const response = await app.request(`/api/analysis-jobs/${job.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    await job.completion;
    expect(job.status().state).toBe("cancelled");
    expect(commands).not.toContain("go infinite");
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });
});
