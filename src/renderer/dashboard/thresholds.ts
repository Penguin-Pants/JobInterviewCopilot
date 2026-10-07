/**
 * Threshold input parsing for the Dashboard (FR-031).
 */

/**
 * The number in a threshold field, or `null` when the field is empty, is not a
 * number or is out of the range. An empty field is refused before conversion,
 * because `Number('')` is `0` and zero turns the warning off.
 */
export function parseThreshold(raw: string, range: { min: number; max: number }): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return value >= range.min && value <= range.max ? value : null;
}
