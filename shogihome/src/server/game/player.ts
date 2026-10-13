import { Color, type ImmutablePosition } from "tsshogi";
import type { Player, SearchHandler, SearchInfo } from "@/common/game/player";
import type { TimeStates } from "@/common/game/time";
import type { GameResult } from "@/common/game/result";
import { gameGoCommand } from "@/common/game/usi_time";
import { parseUSIPV } from "@/common/game/usi";
import { parseAnalysisInfo } from "@/common/analysis/types";
import type { USIEngineExtraBookConfig } from "@/common/settings/usi";
import type { EngineConfig } from "@/server/engine/types";
import type { ResourceLease } from "@/server/engine/resources";
import { InternalEngine, type GameEngine, type ResearchSearch } from "@/server/engine/internal";
import { searchGameBook, type GameBook } from "./book";

export class HumanPlayer implements Player {
  readonly supportsTakeback = true;
  isEngine(): boolean {
    return false;
  }
  async readyNewGame(): Promise<void> {}
  async startSearch(): Promise<void> {}
  async startPonder(): Promise<void> {}
  async startMateSearch(): Promise<void> {}
  async stop(): Promise<void> {}
  async cancelSearch(): Promise<void> {}
  async gameover(): Promise<void> {}
  async close(): Promise<void> {}
}

export class GamePlayer implements Player {
  readonly supportsTakeback = true;
  private generation = 0;
  private controller?: AbortController;
  private search?: ResearchSearch;
  private starting?: Promise<void>;
  private closing?: Promise<void>;

  constructor(
    private readonly engine: GameEngine = new InternalEngine(),
    private readonly book?: GameBook,
    private readonly extraBook?: USIEngineExtraBookConfig,
    private readonly onInfo: (info: SearchInfo) => void = () => {},
    private readonly onLiveInfo: (
      position: string,
      info: ReturnType<typeof parseAnalysisInfo>,
    ) => void = () => {},
  ) {}
  async launch(
    config: EngineConfig,
    timeout: number,
    signal: AbortSignal,
    resourceLease?: ResourceLease,
  ): Promise<void> {
    await this.engine.launch(config, timeout, signal, resourceLease);
  }
  isEngine(): boolean {
    return true;
  }
  async readyNewGame(): Promise<void> {
    this.engine.readyNewGame();
  }
  async startPonder(): Promise<void> {}
  async startMateSearch(): Promise<void> {}

  startSearch(
    position: ImmutablePosition,
    usi: string,
    times: TimeStates,
    handler: SearchHandler,
  ): Promise<void> {
    const generation = ++this.generation;
    const controller = (this.controller = new AbortController());
    let info: SearchInfo | undefined;
    let terminal = false;
    const current = () => !controller.signal.aborted && generation === this.generation;
    const run = async () => {
      if (this.book && this.extraBook) {
        const move = await searchGameBook(
          this.book,
          position,
          usi,
          this.extraBook,
          controller.signal,
          (line) => this.onLiveInfo(usi, line),
        );
        if (!current()) return;
        if (move) {
          handler.onMove(move);
          return;
        }
      }
      if (!current()) return;
      this.search = await this.engine.startSearch(
        usi,
        gameGoCommand(position.color, times),
        (line) => {
          if (!current()) return;
          const parsed = parseAnalysisInfo(line);
          if (parsed) {
            this.onLiveInfo(usi, parsed);
            if ((parsed.multipv ?? 1) !== 1) return;
            const sign = position.color === Color.BLACK ? 1 : -1;
            info = {
              ...info,
              usi,
              ...(parsed.depth === undefined ? {} : { depth: parsed.depth }),
              ...(parsed.nodes === undefined ? {} : { nodes: parsed.nodes }),
              ...(parsed.scoreCP === undefined && parsed.scoreMate === undefined
                ? {}
                : {
                    score: parsed.scoreCP === undefined ? undefined : sign * parsed.scoreCP,
                    mate: parsed.scoreMate === undefined ? undefined : sign * parsed.scoreMate,
                    lowerBound: parsed.lowerbound,
                    upperBound: parsed.upperbound,
                  }),
              ...(parsed.pv ? { pv: parseUSIPV(position, parsed.pv) } : {}),
            };
            this.onInfo(info);
          } else if (line.startsWith("bestmove ") && !terminal) {
            terminal = true;
            const move = line.split(/\s+/)[1];
            queueMicrotask(() => {
              if (!current()) return;
              try {
                if (move === "resign") handler.onResign();
                else if (move === "win") handler.onWin();
                else {
                  const decoded = position.createMoveByUSI(move);
                  if (!decoded) handler.onError(new Error("Invalid engine bestmove"));
                  else if (info?.pv?.length && info.pv[0].equals(decoded)) {
                    // The PV starts with the move being played; record it from the next node.
                    handler.onMove(decoded, { ...info, pv: info.pv.slice(1) });
                  } else {
                    // A PV that disagrees with the bestmove is not reliable for the record.
                    handler.onMove(decoded);
                  }
                }
              } catch (error) {
                handler.onError(error);
              }
            });
          }
        },
        controller.signal,
      );
      void this.search.finished.catch((error) => {
        if (current()) handler.onError(error);
      });
    };
    this.starting = run();
    return this.starting;
  }
  async cancelSearch(): Promise<void> {
    ++this.generation;
    this.controller?.abort();
    await this.engine.cancelAll();
    await this.starting?.catch(() => {});
    this.search = undefined;
  }
  async stop(): Promise<void> {
    await this.search?.stop();
  }
  async gameover(result: GameResult): Promise<void> {
    await this.cancelSearch();
    this.engine.gameover(result);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      ++this.generation;
      this.controller?.abort();
      try {
        await this.engine.close();
      } finally {
        this.book?.close();
      }
    })());
  }
}
