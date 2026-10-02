// Fixed per-import limits; these are not user-facing settings or memory budgets.
export const BOOK_IMPORT_LIMITS = Object.freeze({
  maxMoves: 1_000_000,
  maxFiles: 20_000,
  maxScannedEntries: 100_000,
  maxTotalBytes: 1_280 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxDepth: 10,
  timeoutMs: 300_000,
});
