const findLast = (
  commands: readonly string[],
  predicate: (command: string) => boolean,
): { command: string; index: number } | undefined => {
  for (let index = commands.length - 1; index >= 0; index--) {
    const command = commands[index];
    if (predicate(command)) {
      return { command, index };
    }
  }
  return undefined;
};

export function collectPostStopCommands(queuedCommands: readonly string[]): string[] {
  const startIndex = queuedCommands.lastIndexOf("usinewgame");
  const commands = queuedCommands.slice(startIndex >= 0 ? startIndex : 0);
  const result: string[] = [];

  // MultiPV persists across game boundaries, unlike positions and searches.
  const latestMultiPV = findLast(queuedCommands, (cmd) => cmd.startsWith("setoption name MultiPV"));
  const latestGameover = findLast(commands, (cmd) => cmd.startsWith("gameover"));
  const latestPosition = findLast(commands, (cmd) => cmd.startsWith("position"));
  const latestGo = findLast(commands, (cmd) => cmd.startsWith("go"));
  const latestStop = findLast(commands, (cmd) => cmd === "stop");

  if (startIndex >= 0) {
    const previousGameover = findLast(queuedCommands.slice(0, startIndex), (cmd) =>
      cmd.startsWith("gameover"),
    );
    if (previousGameover) result.push(previousGameover.command);
    result.push("usinewgame");
  }
  if (latestMultiPV) {
    result.push(latestMultiPV.command);
  }
  if (latestGameover) {
    result.push(latestGameover.command);
  }
  if (latestPosition) {
    result.push(latestPosition.command);
  }
  if (latestGo && (!latestPosition || latestGo.index > latestPosition.index)) {
    result.push(latestGo.command);
    // A stop belongs only to the retained search, not a later replacement.
    if (latestStop && latestStop.index > latestGo.index) result.push(latestStop.command);
  }

  const knownCommands = new Set(result);
  const knownKinds = new Set([
    "setoption name MultiPV",
    "gameover",
    "position",
    "go",
    "stop",
    "usinewgame",
  ]);
  for (const command of commands) {
    const known =
      knownKinds.has(command) || [...knownKinds].some((kind) => command.startsWith(kind));
    if (!known && !knownCommands.has(command)) {
      result.push(command);
      knownCommands.add(command);
    }
  }
  return result;
}
