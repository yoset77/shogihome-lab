import { Move, Record, SpecialMoveType } from "tsshogi";
import { defaultGameSettings, type GameSettings } from "@/common/settings/game";
import { ES_HUMAN } from "@/common/uri";
import { GameManager } from "@/renderer/store/game";
import { Clock } from "@/renderer/store/clock";
import { RecordManager } from "@/renderer/store/record";
import { HumanPlayer } from "@/renderer/players/human";
import type { Player, SearchHandler } from "@/renderer/players/player";

vi.mock("@/renderer/ipc/api");

async function setup(options: Partial<GameSettings> = {}, record = new Record()) {
  const settings = {
    ...defaultGameSettings(),
    black: { uri: ES_HUMAN, name: "Human" },
    white: { uri: "lan-engine:test", name: "AI" },
    timeLimit: { timeSeconds: 30, byoyomi: 0, increment: 2 },
    whiteTimeLimit: { timeSeconds: 60, byoyomi: 0, increment: 3 },
    enableComment: false,
    ...options,
  };
  const human = new HumanPlayer();
  const requests: SearchHandler[] = [];
  const ai: Player = {
    isEngine: () => true,
    supportsTakeback: true,
    readyNewGame: vi.fn(async () => {}),
    startSearch: vi.fn(async (_p, _u, _t, handler) => {
      requests.push(handler);
    }),
    startPonder: vi.fn(async () => {}),
    startMateSearch: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancelSearch: vi.fn(async () => {}),
    gameover: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const records = new RecordManager(record);
  const black = new Clock();
  const white = new Clock();
  const end = vi.fn();
  const error = vi.fn();
  const game = new GameManager(records, black, white).on("gameEnd", end).on("error", error);
  await game.start(settings, { build: async (player) => (player.uri === ES_HUMAN ? human : ai) });
  await vi.advanceTimersByTimeAsync(0);
  const move = (usi: string) => records.record.position.createMoveByUSI(usi) as Move;
  return { game, human, ai, requests, records, black, white, end, error, move };
}

describe("game takeback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("waits for cancellation, ignores late moves and restores both clocks without increments", async () => {
    const { game, human, ai, requests, records, black, white, move } = await setup();
    expect(game.canTakeback).toBe(false);
    await vi.advanceTimersByTimeAsync(1200);
    human.doMove(move("7g7f"));
    const lateMove = move("3c3d");
    let finish!: () => void;
    vi.mocked(ai.cancelSearch!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = game.takeback();
    expect(game.isTakingBack).toBe(true);
    expect(game.canTakeback).toBe(false);
    await game.takeback();
    expect(ai.cancelSearch).toHaveBeenCalledOnce();
    requests[0].onMove(lateMove);
    requests[0].onResign();
    requests[0].onError(new Error("obsolete"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(records.record.current.ply).toBe(1);
    finish();
    await pending;
    expect(records.record.current.ply).toBe(0);
    expect(records.record.current.next).toBeNull();
    expect(black.timeMs).toBe(30000);
    expect(white.timeMs).toBe(60000);
    expect(game.canTakeback).toBe(false);
    human.doMove(move("7g7f"));
    requests[0].onMove(lateMove);
    expect(records.record.current.ply).toBe(1);
    requests[1].onMove(move("3c3d"));
    expect(records.record.current.ply).toBe(2);
  });

  it("takes back two plies after an AI reply and supports repeated takebacks", async () => {
    const { game, human, requests, records, move, black, white } = await setup();
    human.doMove(move("7g7f"));
    requests[0].onMove(move("3c3d"));
    human.doMove(move("2g2f"));
    requests[1].onMove(move("8c8d"));
    await game.takeback();
    expect(records.record.current.ply).toBe(2);
    expect(black.timeMs).toBe(32000);
    expect(white.timeMs).toBe(63000);
    await game.takeback();
    expect(records.record.current.ply).toBe(0);
    expect(records.record.current.next).toBeNull();
  });

  it("supports the human playing white and does not undo the AI opening", async () => {
    const { game, human, requests, records, move } = await setup({
      black: { uri: "lan-engine:test", name: "AI" },
      white: { uri: ES_HUMAN, name: "Human" },
    });
    expect(game.canTakeback).toBe(false);
    requests[0].onMove(move("7g7f"));
    expect(game.canTakeback).toBe(false);
    human.doMove(move("3c3d"));
    await game.takeback();
    expect(records.record.current.ply).toBe(1);
    expect(game.canTakeback).toBe(false);
  });

  it("preserves pre-existing continuations when starting from the middle of a record", async () => {
    const record = Record.newByUSI("position startpos moves 7g7f 3c3d 2g2f") as Record;
    record.current.comment = "Existing annotation";
    record.goto(2);
    const { game, human, records, move } = await setup({ startPosition: "current" }, record);
    human.doMove(move("2g2f"));
    await game.takeback();
    expect(records.record.current.ply).toBe(2);
    expect(records.record.current.next?.comment).toBe("Existing annotation");
    expect(game.canTakeback).toBe(false);
  });

  it("interrupts without rollback if cancellation fails", async () => {
    const { game, human, ai, records, move, end, error } = await setup();
    human.doMove(move("7g7f"));
    vi.mocked(ai.cancelSearch!).mockRejectedValue(new Error("connection expired"));
    await game.takeback();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledOnce();
    expect(records.record.current.prev?.ply).toBe(1);
    expect(end).toHaveBeenCalledWith(expect.anything(), SpecialMoveType.INTERRUPT);
    expect(game.isActive).toBe(false);
  });

  it("never resumes when interrupted while cancellation is pending", async () => {
    const { game, human, ai, records, move, end } = await setup();
    human.doMove(move("7g7f"));
    let finish!: () => void;
    vi.mocked(ai.cancelSearch!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = game.takeback();
    game.stop();
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await pending;
    expect(end).toHaveBeenCalledOnce();
    expect(records.record.current.prev?.ply).toBe(1);
    expect(game.isActive).toBe(false);
  });

  it("settles an expired clock before accepting takeback", async () => {
    const { game, human, requests, move, end } = await setup({
      timeLimit: { timeSeconds: 1, byoyomi: 0, increment: 0 },
    });
    human.doMove(move("7g7f"));
    requests[0].onMove(move("3c3d"));
    vi.setSystemTime(Date.now() + 1001);
    await game.takeback();
    await vi.advanceTimersByTimeAsync(0);
    expect(end).toHaveBeenCalledWith(expect.anything(), SpecialMoveType.TIMEOUT);
  });

  it("restores byoyomi and does not time out during cancellation", async () => {
    const { game, human, ai, requests, black, white, move } = await setup({
      timeLimit: { timeSeconds: 0, byoyomi: 10, increment: 0 },
      whiteTimeLimit: { timeSeconds: 0, byoyomi: 20, increment: 0 },
    });
    await vi.advanceTimersByTimeAsync(3000);
    human.doMove(move("7g7f"));
    await vi.advanceTimersByTimeAsync(4000);
    requests[0].onMove(move("3c3d"));
    let finish!: () => void;
    vi.mocked(ai.cancelSearch!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = game.takeback();
    await vi.advanceTimersByTimeAsync(30000);
    expect(game.isTakingBack).toBe(true);
    finish();
    await pending;
    expect(black.byoyomi).toBe(10);
    expect(white.byoyomi).toBe(20);
    expect(black.elapsedMs).toBe(0);
  });
});
