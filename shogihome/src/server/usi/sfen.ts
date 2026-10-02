import { Record, Position } from "tsshogi";
import { hash as aperyHash } from "@/server/book/apery_zobrist";
import { normalizeSfen } from "@/common/usi/sfen";

/** Parse a raw SFEN or USI position command without computing a hash. */
export function getNormalizedSfen(usiPositionCommand: string): string | null {
  try {
    let record: Record | Error;

    if (usiPositionCommand.startsWith("position ")) {
      record = Record.newByUSI(usiPositionCommand);
    } else if (usiPositionCommand.startsWith("sfen ")) {
      record = Record.newByUSI("position " + usiPositionCommand);
    } else if (usiPositionCommand.startsWith("startpos")) {
      record = Record.newByUSI("position " + usiPositionCommand);
    } else {
      const position = Position.newBySFEN(usiPositionCommand);
      if (!position) {
        console.warn("Invalid SFEN string:", usiPositionCommand);
        return null;
      }
      return normalizeSfen(position.sfen);
    }

    if (record instanceof Error) {
      console.warn("Failed to parse position:", record.message, `(input: ${usiPositionCommand})`);
      return null;
    }

    return normalizeSfen(record.position.sfen);
  } catch (e) {
    console.warn("Exception during getNormalizedSfen:", e);
    return null;
  }
}

/** Add a signed 64-bit Apery hash for engine and SQLite consumers. */
export function getNormalizedSfenAndHash(usiPositionCommand: string): {
  sfen: string;
  hash: bigint;
} | null {
  const sfen = getNormalizedSfen(usiPositionCommand);
  if (sfen === null) return null;
  try {
    return { sfen, hash: BigInt.asIntN(64, aperyHash(`${sfen} 1`)) };
  } catch (e) {
    console.warn("Exception during getNormalizedSfenAndHash:", e);
    return null;
  }
}
