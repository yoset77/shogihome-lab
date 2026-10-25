import { readParallelGameProgress } from "@/common/game/parallel";
import { newGameResults } from "@/common/game/results";
import { decodeJobList, type JobSummary } from "@/common/jobs/types";

describe("parallel game progress protocol", () => {
  const progress = { parallelism: 2, activeGames: 2, results: newGameResults("A", "B") };
  const job: JobSummary = {
    kind: "game",
    id: "game",
    requestId: "request",
    serverInstanceId: "server",
    createdAt: 1,
    state: "running",
    engines: ["A", "B"],
    completed: 0,
    total: 5,
    attachment: { attached: false, epoch: 0 },
    parallelGame: progress,
  };
  it("accepts bounded worker progress and fixed-player results", () => {
    expect(readParallelGameProgress(progress)).toEqual(progress);
    expect(decodeJobList([job])).toMatchObject({ ok: true, value: [job] });
  });
  it.each([
    { ...progress, parallelism: 1 },
    { ...progress, parallelism: 17 },
    { ...progress, activeGames: 3 },
    { ...progress, activeGames: -1 },
    { ...progress, results: { ...progress.results, total: 1 } },
    {
      ...progress,
      results: { ...progress.results, player1: { ...progress.results.player1, win: 1 } },
    },
  ])("rejects malformed progress %j", (value) =>
    expect(() => readParallelGameProgress(value)).toThrow(),
  );
  it.each([
    { ...job, kind: "analysis" },
    { ...job, completed: 1 },
    { ...job, total: 1 },
    { ...job, attachment: { attached: true, epoch: 1 } },
  ])("rejects inconsistent parallel job summaries %j", (value) =>
    expect(decodeJobList([value]).ok).toBe(false),
  );
});
