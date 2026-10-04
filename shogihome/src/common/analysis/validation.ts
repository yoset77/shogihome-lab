export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

export function text(value: unknown, max = 65_536): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid string");
  return value;
}

export function counter(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error("Invalid counter");
  return value;
}

export function finite(
  value: unknown,
  min = -Number.MAX_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error("Invalid number");
  return value;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid boolean");
  return value;
}

export function identifier(value: unknown): string {
  const result = text(value, 100);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(result)) throw new Error("Invalid identifier");
  return result;
}

export function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid array");
  return value;
}

export function enumeration<T extends string | number>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error("Invalid enum");
  return value as T;
}
