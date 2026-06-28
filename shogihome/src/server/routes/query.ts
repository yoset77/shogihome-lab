export const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const getOptionalInt = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};
