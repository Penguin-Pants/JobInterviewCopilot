/**
 * How long the soak runs (`TC-131`, `NFR-004`).
 *
 * Shared by the test and by `vitest.soak.config.ts`, which has to set a timeout
 * longer than the run. Two copies of this arithmetic is how a soak ends up
 * timing out one minute before it finishes.
 *
 * `SOAK_MINUTES` must survive being set to the empty string, which is what a
 * GitHub Actions `workflow_dispatch` input evaluates to on a scheduled run.
 * `??` does not: an empty string is not nullish, so `Number('')` is 0 and the
 * nightly soak would measure nothing.
 */

/** The full hour `NFR-004` names. */
export const DEFAULT_SOAK_MINUTES = 60;

/** Minutes to soak for, from `SOAK_MINUTES`, falling back to the full hour. */
export function soakMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SOAK_MINUTES?.trim();
  if (!raw) return DEFAULT_SOAK_MINUTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SOAK_MINUTES;
}
