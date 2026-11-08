import { collectPostStopCommands } from "@/server/engine/command_queue";

describe("post-stop command selection", () => {
  it.each([
    { name: "handles an empty queue", commands: [], expected: [] },
    {
      name: "replays only the latest option, gameover, position and go in their existing order",
      commands: [
        "position startpos",
        "setoption name MultiPV value 3",
        "gameover win",
        "go infinite",
        "setoption name MultiPV value 5",
        "gameover draw",
        "position startpos moves 7g7f",
        "go btime 1000 wtime 1000",
      ],
      expected: [
        "setoption name MultiPV value 5",
        "gameover draw",
        "position startpos moves 7g7f",
        "go btime 1000 wtime 1000",
      ],
    },
    {
      name: "omits a go that precedes the latest position",
      commands: ["position startpos", "go infinite", "position startpos moves 7g7f"],
      expected: ["position startpos moves 7g7f"],
    },
    {
      name: "keeps a go without a queued position",
      commands: ["go infinite", "go btime 1000 wtime 1000"],
      expected: ["go btime 1000 wtime 1000"],
    },
    {
      name: "keeps the last new game and its preceding gameover",
      commands: [
        "gameover win",
        "usinewgame",
        "position startpos",
        "go infinite",
        "gameover draw",
        "usinewgame",
        "setoption name MultiPV value 2",
        "position startpos moves 7g7f",
        "go infinite",
      ],
      expected: [
        "gameover draw",
        "usinewgame",
        "setoption name MultiPV value 2",
        "position startpos moves 7g7f",
        "go infinite",
      ],
    },
    {
      name: "preserves MultiPV across the last new game",
      commands: ["setoption name MultiPV value 3", "gameover draw", "usinewgame"],
      expected: ["gameover draw", "usinewgame", "setoption name MultiPV value 3"],
    },
    {
      name: "keeps only the latest MultiPV across multiple new games",
      commands: [
        "setoption name MultiPV value 2",
        "usinewgame",
        "setoption name MultiPV value 3",
        "position startpos",
        "go infinite",
        "gameover draw",
        "usinewgame",
      ],
      expected: ["gameover draw", "usinewgame", "setoption name MultiPV value 3"],
    },
    {
      name: "prefers MultiPV set after the last new game",
      commands: ["setoption name MultiPV value 3", "usinewgame", "setoption name MultiPV value 5"],
      expected: ["usinewgame", "setoption name MultiPV value 5"],
    },
    {
      name: "keeps one stop after the retained go",
      commands: ["position startpos", "go infinite", "stop", "stop"],
      expected: ["position startpos", "go infinite", "stop"],
    },
    {
      name: "omits a stop without a retained go",
      commands: ["stop", "position startpos"],
      expected: ["position startpos"],
    },
    {
      name: "does not carry a stop into a replacement go",
      commands: ["position startpos", "go infinite", "stop", "go btime 1000 wtime 1000"],
      expected: ["position startpos", "go btime 1000 wtime 1000"],
    },
    {
      name: "drops a stop when a newer position invalidates its go",
      commands: ["position startpos", "go infinite", "stop", "position startpos moves 7g7f"],
      expected: ["position startpos moves 7g7f"],
    },
    {
      name: "does not carry a stop across a new game",
      commands: ["go infinite", "stop", "usinewgame", "go infinite"],
      expected: ["usinewgame", "go infinite"],
    },
    {
      name: "keeps a gameover after the last new game",
      commands: ["gameover win", "usinewgame", "gameover draw"],
      expected: ["gameover win", "usinewgame", "gameover draw"],
    },
    {
      name: "appends other commands once in their original order",
      commands: ["isready", "position startpos", "ponderhit", "isready", "go infinite"],
      expected: ["position startpos", "go infinite", "isready", "ponderhit"],
    },
  ])("$name without mutating its input", ({ commands, expected }) => {
    const queued = Object.freeze([...commands]);
    expect(collectPostStopCommands(queued)).toEqual(expected);
    expect(queued).toEqual(commands);
  });
});
