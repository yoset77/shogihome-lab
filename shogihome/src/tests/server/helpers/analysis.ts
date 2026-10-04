import { Color, Record } from "tsshogi";
import { defaultAnalysisSettings } from "@/common/settings/analysis";
import { defaultAppSettings } from "@/common/settings/app";
import { snapshotRecord } from "@/common/record/snapshot";
import type { AnalysisJobRequest } from "@/common/analysis/types";
import type { ResearchEngine, ResearchSearch } from "@/server/engine/internal";

export function requestFor(
  record = Record.newByUSI("position startpos moves 7g7f 3c3d 2g2f 8c8d resign") as Record,
): AnalysisJobRequest {
  const app = defaultAppSettings();
  const settings = defaultAnalysisSettings();
  delete settings.usi;
  return {
    requestId: "request-1",
    serverInstanceId: "server-1",
    source: snapshotRecord(record),
    options: {
      ...settings,
      perMoveCriteria: { maxSeconds: 1 },
      engineId: "test",
      engineTimeoutSeconds: 10,
      commentFormat: app.searchCommentFormat,
      language: app.language,
      accuracy: {
        coefficientInSigmoid: app.coefficientInSigmoid,
        badMoveLevelThreshold1: app.badMoveLevelThreshold1,
        badMoveLevelThreshold2: app.badMoveLevelThreshold2,
        badMoveLevelThreshold3: app.badMoveLevelThreshold3,
        badMoveLevelThreshold4: app.badMoveLevelThreshold4,
      },
    },
  };
}

export class FakeResearchEngine implements ResearchEngine {
  scores: (number | undefined)[] = [10, 20, 30, 40, 50, 60, 70];
  output?: (line: string) => void;
  prepareDelay = 0;
  stopDelay = 0;
  positions: string[] = [];
  launch = vi.fn<ResearchEngine["launch"]>(async () => {});
  readyNewGame = vi.fn();
  close = vi.fn(async () => {});
  stops = vi.fn();
  cancellations = vi.fn();

  async startResearch(
    position: string,
    output: (line: string) => void,
    signal: AbortSignal,
  ): Promise<ResearchSearch> {
    this.positions.push(position);
    this.output = output;
    if (this.prepareDelay)
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("Cancelled"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, this.prepareDelay);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const score = this.scores[this.positions.length - 1];
    const record = Record.newByUSI(position) as Record;
    if (score !== undefined)
      output(`info score cp ${score * (record.position.color === Color.BLACK ? 1 : -1)}`);
    return {
      finished,
      stop: async () => {
        this.stops();
        if (this.stopDelay) await new Promise((resolve) => setTimeout(resolve, this.stopDelay));
        finish();
      },
      cancel: async () => {
        this.cancellations();
        finish();
      },
    };
  }
}
