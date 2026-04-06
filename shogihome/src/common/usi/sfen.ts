/**
 * Normalize a SFEN string by removing the trailing move count.
 * e.g. "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1" -> "... b -"
 */
export function normalizeSfen(sfen: string): string {
  return sfen.replace(/\s+\d+$/, "");
}
