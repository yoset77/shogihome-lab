// Helpers for TYPE_LIST server settings (.env comma-joined values).
// The backend stores lists as a single comma-joined string; the settings UI
// edits them as one input row per item (launcher.py _build_setting_row
// parity) and joins on save. Order is preserved, empties are dropped.

export function splitListValue(raw: unknown): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function joinListValue(items: string[]): string {
  return items
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(",");
}

/**
 * Choice options for a select, preserving an existing custom value (e.g.
 * BIND_ADDRESS=192.168.1.10) so editing an unrelated field does not
 * silently rewrite it to the first schema choice.
 */
export function choiceOptions(choices: string[], current: unknown): string[] {
  if (typeof current === "string" && current !== "" && !choices.includes(current)) {
    return [current, ...choices];
  }
  return [...choices];
}
