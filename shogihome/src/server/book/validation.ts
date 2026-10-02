import { SbkMoveEvaluation, type BookFormat, type BookMove } from "@/common/book";
import { getNormalizedSfen } from "@/server/usi/sfen";
import { HttpError } from "@/server/errors";
import { t } from "@/common/i18n";

const USI_MOVE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;

export function parseBookSfen(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 512 ||
    /[\r\n]/.test(input) ||
    input.includes("\0")
  ) {
    throw new HttpError(400, t.serverInvalidBookPosition);
  }
  const sfen = getNormalizedSfen(input);
  if (sfen === null) throw new HttpError(400, t.serverInvalidBookPosition);
  return `${sfen} 1`;
}

export function parseBookUsi(input: unknown): string {
  if (typeof input !== "string" || !USI_MOVE.test(input)) {
    throw new HttpError(400, t.serverInvalidBookMove);
  }
  return input;
}

const optionalInteger = (value: unknown, min: number, max: number): number | undefined => {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, t.serverInvalidBookNumber);
  }
  return value;
};

export function parseBookMove(input: unknown, format: BookFormat): BookMove {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, t.serverInvalidBookMove);
  }
  const raw = input as Record<string, unknown>;
  const usi = parseBookUsi(raw.usi);
  const usi2 = raw.usi2 === undefined ? undefined : parseBookUsi(raw.usi2);
  if (typeof raw.comment !== "string" || raw.comment.length > 4096) {
    throw new HttpError(400, t.serverInvalidBookComment);
  }
  const score = optionalInteger(
    raw.score,
    format === "ybb" ? -32768 : -2147483648,
    format === "ybb" ? 32767 : 2147483647,
  );
  const depth = optionalInteger(raw.depth, 0, format === "ybb" ? 65535 : 2147483647);
  const count = optionalInteger(raw.count, 0, format === "apery" ? 65535 : 2147483647);
  const evaluation = raw.evaluation;
  if (
    evaluation !== undefined &&
    !Object.values(SbkMoveEvaluation).includes(evaluation as SbkMoveEvaluation)
  ) {
    throw new HttpError(400, t.serverInvalidBookEvaluation);
  }
  return {
    usi,
    ...(usi2 === undefined ? {} : { usi2 }),
    comment: raw.comment,
    ...(score === undefined ? {} : { score }),
    ...(depth === undefined ? {} : { depth }),
    ...(count === undefined ? {} : { count }),
    ...(evaluation === undefined ? {} : { evaluation: evaluation as SbkMoveEvaluation }),
  };
}
