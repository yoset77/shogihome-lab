import { GameRecord } from "@/common/game/record";
import { GameResult } from "@/common/game/result";
import { newGameResults } from "@/common/game/results";
import type { ParallelGameProgress } from "@/common/game/parallel";
import type { GameRecordSummary, GameSessionRequest } from "@/common/game/protocol";
import { restoreRecord, snapshotRecord } from "@/common/record/snapshot";
import { getLanEngineId } from "@/common/uri";
import { InternalEngine } from "@/server/engine/internal";
import type { EngineConfig } from "@/server/engine/types";
import type { ResourceLease } from "@/server/engine/resources";
import { Clock } from "./clock";
import { GameController, type PlayerBuilder } from "./controller";
import { buildGameCoordinator, type GameAssignment } from "./coordinator";
import { GamePlayer } from "./player";
import { GameBook } from "./book";
import { persistGameRecord } from "./persistence";
import type { GameDependencies } from "./session";
import { MAX_GAME_SNAPSHOT_BYTES } from "./limits";
import { HttpError } from "@/server/errors";
import { t } from "@/common/i18n";

type Worker = { core: GameController; assignment?: GameAssignment; done: Promise<void> };

export class ParallelGames {
  readonly results;
  readonly records: GameRecordSummary[] = [];
  private workers: Worker[] = [];
  private stopped = false;
  private readonly abort = new AbortController();
  constructor(
    private readonly id: string,
    private readonly request: GameSessionRequest,
    private readonly deps: GameDependencies,
    private readonly configs: ReadonlyMap<string, EngineConfig>,
    private readonly lease: ResourceLease | undefined,
    private readonly onError: (error: unknown) => void,
    private readonly onSaveError: () => void,
  ) {
    const name = (player: typeof request.settings.black) =>
      configs.get(getLanEngineId(player.uri, "game")!)?.name ?? player.name;
    this.results = newGameResults(name(request.settings.black), name(request.settings.white));
  }
  progress(): ParallelGameProgress {
    return {
      parallelism: this.request.settings.parallelism!,
      activeGames: this.workers.filter((worker) => worker.assignment !== undefined).length,
      results: structuredClone(this.results),
    };
  }
  stop(): void {
    this.stopped = true;
    this.abort.abort();
    for (const worker of this.workers) worker.core.stop();
  }
  async run(): Promise<void> {
    const { settings, options } = this.request;
    const coordinator = await buildGameCoordinator(
      settings,
      this.request.source,
      options.language,
      this.deps.loadPositions,
    );
    if (this.stopped) return;
    const starts: Promise<void>[] = [];
    // Register every worker before starting any asynchronous engine setup.
    for (let index = 0; index < Math.min(settings.parallelism!, settings.repeat); index++) {
      const records = new GameRecord(restoreRecord(this.request.source).record);
      let complete!: () => void;
      let result: GameResult | null = null;
      const worker: Worker = {
        core: new GameController(records, new Clock(this.deps.now), new Clock(this.deps.now), {
          language: options.language,
          commentFormat: options.commentFormat,
          loadPositions: this.deps.loadPositions ?? (async () => []),
          coordinator: {
            next: (record) => {
              worker.assignment = this.stopped ? undefined : coordinator.next(record);
              return worker.assignment;
            },
          },
        }),
        done: new Promise<void>((resolve) => {
          complete = resolve;
        }),
      };
      worker.core
        .on("update", () => {
          if (!worker.core.isActive) return;
          try {
            if (
              Buffer.byteLength(JSON.stringify(snapshotRecord(records.record))) >
              MAX_GAME_SNAPSHOT_BYTES - 256 * 1024
            )
              this.onError(new HttpError(503, t.gameCapacity));
          } catch (error) {
            this.onError(error);
          }
        })
        .on("gameResult", (value) => {
          result = value;
        })
        .on("recordEnd", async () => {
          const assignment = worker.assignment!;
          const summary: GameRecordSummary = {
            gameId: `${this.id}_${assignment.gameNumber}`,
            state: "unsaved",
          };
          await persistGameRecord(
            snapshotRecord(records.record),
            options.save,
            settings,
            summary,
            this.deps,
            this.onSaveError,
          );
          this.records.push(summary);
          this.addResult(result, assignment.swapped);
          worker.assignment = undefined;
        })
        .on("gameEnd", () => {
          worker.assignment = undefined;
          complete();
        })
        .on("error", (error) => this.onError(error));
      this.workers.push(worker);
    }
    for (const worker of this.workers) {
      const builder: PlayerBuilder = this.deps.playerBuilder ?? {
        build: async (playerSettings, onInfo) => {
          const config = this.configs.get(getLanEngineId(playerSettings.uri, "game")!)!;
          playerSettings.name = config.name;
          const extra = playerSettings.usi?.extraBook;
          const book = extra?.enabled ? await GameBook.open(extra) : undefined;
          const player = new GamePlayer(
            (this.deps.createEngine ?? (() => new InternalEngine()))(),
            book,
            extra,
            onInfo,
          );
          try {
            await player.launch(
              config,
              options.engineTimeoutSeconds,
              this.abort.signal,
              this.lease,
            );
            return player;
          } catch (error) {
            await player.close().catch(() => {});
            throw error;
          }
        },
      };
      starts.push(
        worker.core
          .start(structuredClone(settings), builder)
          .catch((error) => {
            if (!this.stopped) this.onError(error);
          })
          .then(async () => {
            // A rejected start has already closed all its initialized players.
            if (!worker.core.isIdle) await worker.done;
            worker.assignment = undefined;
          }),
      );
    }
    await Promise.allSettled(starts);
    this.workers = [];
  }
  private addResult(result: GameResult | null, swapped: boolean): void {
    if (result === GameResult.DRAW) this.results.draw++;
    else if (result === GameResult.WIN || result === GameResult.LOSE) {
      const blackWins = result === GameResult.WIN;
      const player = blackWins !== swapped ? this.results.player1 : this.results.player2;
      player.win++;
      if (blackWins) player.winBlack++;
      else player.winWhite++;
    } else this.results.invalid++;
    this.results.total++;
  }
}
