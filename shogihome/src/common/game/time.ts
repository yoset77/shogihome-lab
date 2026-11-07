export type TimeState = {
  // Main time before the increment for the next search, in milliseconds.
  timeMs: number;
  byoyomi: number;
  increment: number;
};

export type TimeStates = {
  black: TimeState;
  white: TimeState;
};
