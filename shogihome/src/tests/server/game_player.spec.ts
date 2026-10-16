// @vitest-environment node
import { Record, type Move } from "tsshogi";
import { GamePlayer } from "@/server/game/player";
import type { GameEngine } from "@/server/engine/internal";
import type { SearchHandler, SearchInfo } from "@/common/game/player";

describe("server game player", () => {
  const fixture = (usi = "position startpos") => {
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
    const onInfo = vi.fn();
    const onLiveInfo = vi.fn();
    const player = new GamePlayer(engine, undefined, undefined, onInfo, onLiveInfo);
    const record = Record.newByUSI(usi) as Record;
    const start = () =>
      player.startSearch(
        record.position,
        usi,
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
      onInfo,
      onLiveInfo,
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

  describe.each([
    { usi: "position startpos", sign: 1, move: "7g7f" },
    { usi: "position startpos moves 7g7f", sign: -1, move: "3c3d" },
  ])("search scores for $usi", ({ usi, sign, move }) => {
    it.each(["cp", "mate"])("normalizes %s scores and bounds atomically", async (kind) => {
      const { start, emit, settle, onInfo, onLiveInfo, onMove } = fixture(usi);
      await start();
      emit(`info depth 10 score ${kind} 100 lowerbound pv ${move}`);
      const bounded = {
        score: kind === "cp" ? sign * 100 : undefined,
        mate: kind === "mate" ? sign * 100 : undefined,
        lowerBound: sign === 1 ? true : undefined,
        upperBound: sign === -1 ? true : undefined,
      };
      expect(onInfo).toHaveBeenLastCalledWith(expect.objectContaining(bounded));
      expect(onLiveInfo).toHaveBeenLastCalledWith(
        usi,
        expect.objectContaining({
          lowerbound: true,
          [kind === "cp" ? "scoreCP" : "scoreMate"]: 100,
        }),
      );

      emit("info depth 11 nodes 200");
      expect(onInfo).toHaveBeenLastCalledWith(expect.objectContaining({ ...bounded, depth: 11 }));

      const otherKind = kind === "cp" ? "mate" : "cp";
      emit(`info score ${otherKind} 200 upperbound`);
      expect(onInfo).toHaveBeenLastCalledWith(
        expect.objectContaining({
          score: otherKind === "cp" ? sign * 200 : undefined,
          mate: otherKind === "mate" ? sign * 200 : undefined,
          lowerBound: sign === -1 ? true : undefined,
          upperBound: sign === 1 ? true : undefined,
        }),
      );

      emit("info score cp 0");
      const exact = {
        score: 0,
        mate: undefined,
        lowerBound: undefined,
        upperBound: undefined,
      };
      expect(onInfo).toHaveBeenLastCalledWith(expect.objectContaining(exact));
      emit(`bestmove ${move}`);
      await settle();
      expect(onMove).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining(exact));
    });
  });
});
