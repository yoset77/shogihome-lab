// Workbox tests pathname + search, so queries must not affect asset classification.
export const staticAssetPathPatterns = [
  /^\/(?:assets|board|piece|stand|icon|sound|puzzles)(?:\/|\?|$)/i,
  /^\/(?:[^/?]*\/)*[^./?]*\.[^/?]*(?:\?|$)/,
];
