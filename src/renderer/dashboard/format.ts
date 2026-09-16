/**
 * Presentation helpers for the Dashboard (CMP-13, TASK-042).
 *
 * English only, as `NFR-014` fixes for v1, so the formats are written out
 * rather than delegated to a locale the app does not ship.
 */

/** `h:mm:ss` for the live session timer (FR-103, TC-125). */
export function formatElapsed(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * A dollar amount.
 *
 * Four decimals below a cent, because a short session costs fractions of a cent
 * and `$0.00` would read as free (FR-072).
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '$0.00';
  return amount > 0 && amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

/** A file size, for the knowledge base ceiling sentence (FR-068). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}

/** An ISO timestamp as a readable local date and time. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('en-US');
}
