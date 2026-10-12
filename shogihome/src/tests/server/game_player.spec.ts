// @vitest-environment node
import { Position, type Move } from "tsshogi";
import { GamePlayer } from "@/server/game/player";
import type { GameEngine } from "@/server/engine/internal";
import type { SearchHandler, SearchInfo } from "@/common/game/player";

describe("server game player", () => {
  const fixture = () => {
    let onOutput!: (line: string) => void;
    const engine: GameEngine = {
      launch: vi.fn(),
      setMultiPV: vi.fn(),
      readyNewGame: vi.fn(),
      startResearch: vi.fn(),
      startSearch: vi.fn(async (_position, _go, output) => {
        onOutput = output;
        return {
          finished: new Promise<void>(() => {}),
          stop: vi.fn(),
          cancel: vi.fn(),
        };
      }),
      cancelAll: vi.fn(async () => {}),
      gameover: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const onMove = vi.fn<(move: Move, info?: SearchInfo) => void>();
    const handler: SearchHandler = {
      onMove,
      onResign: vi.fn(),
      onWin: vi.fn(),
      onError: vi.fn(),
    };
    const player = new GamePlayer(engine);
    const start = () =>
      player.startSearch(
        new Position(),
        "position startpos",
        {
          black: { timeMs: 30_000, byoyomi: 0, increment: 0 },
          white: { timeMs: 30_000, byoyomi: 0, increment: 0 },
        },
        handler,
      );
    const settle = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    return {
      player,
      engine,
      handler,
      onMove,
      start,
      emit: (line: string) => onOutput(line),
      settle,
    };
  };

  it("strips the played move from the PV before recording the search info", async () => {
    const { onMove, start, emit, settle } = fixture();
    await start();
    emit("info depth 8 score cp 20 nodes 100 pv 7g7f 3c3d 2g2f");
    emit("bestmove 7g7f");
    await settle();
    expect(onMove).toHaveBeenCalledOnce();
    const [move, info] = onMove.mock.calls[0];
    expect(move.usi).toBe("7g7f");
    expect(info?.pv?.map((entry) => entry.usi)).toEqual(["3c3d", "2g2f"]);
    expect(info?.score).toBe(20);
    expect(info?.depth).toBe(8);
  });

  it("drops the search info when the bestmove does not match the PV head", async () => {
    const { onMove, start, emit, settle } = fixture();
    await start();
    emit("info depth 8 score cp 20 nodes 100 pv 3c3d 2g2f");
    emit("bestmove 7g7f");
    await settle();
    expect(onMove).toHaveBeenCalledOnce();
    const [move, info] = onMove.mock.calls[0];
    expect(move.usi).toBe("7g7f");
    expect(info).toBeUndefined();
  });
});
