/**
 * A leading-edge throttle with a trailing commit (FR-086, FR-093, TASK-043).
 *
 * `CH-126 overlay:setFontSize` is the one write the overlay renderer can reach.
 * Its schema bounds the **value** to 16 to 32 and its handler drops a write
 * that changes nothing, but neither bounds the **rate**: a compromised overlay
 * renderer alternating 16 and 32 lands a `config.set` per call, and that is a
 * synchronous settings write on the same event loop as the live audio and STT
 * loop. A narrow write capability turns into a way to stall an interview, which
 * is a worse outcome than the one the allowlist was narrowed to prevent.
 *
 * Leading edge, because the first press of a button must feel immediate: a
 * plain debounce would delay every adjustment by the window. Trailing commit,
 * because the last value asked for must be the one stored, whatever the rate.
 * Between the two, the cost of any number of calls inside one window is one
 * write.
 *
 * The clock and the timer are injected so the behaviour is driven with fake
 * timers in the unit suite rather than by waiting. `src/main/index.ts` is
 * excluded from coverage and cannot be imported by a unit test, which is why
 * this is a module of its own rather than a closure in the handler.
 */

/** The timer surface this needs, so a test can supply its own. */
export interface ThrottleTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/* v8 ignore start -- the real clock and the real timer. Every behaviour that
   depends on them is driven through an injected `ThrottleTimers` in
   tests/unit/write-throttle.test.ts; what is left here is three one-line
   bindings to the platform. */
const systemTimers: ThrottleTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
/* v8 ignore stop */

/**
 * Wrap `commit` so it runs at most once per `intervalMs`.
 *
 * The first call in a quiet period commits immediately. Calls inside the window
 * are coalesced, and the **last** value among them is committed when the window
 * closes.
 *
 * Values are not compared here. Whether a value is worth storing is the
 * commit's own question, and the caller in `src/main/index.ts` answers it by
 * returning without writing when the size has not moved. So a renderer looping
 * one value still costs one coalesced timer per window, and no settings write
 * at all, which is the cost this module exists to bound.
 */
export function throttleWrites<T>(
  commit: (value: T) => void,
  intervalMs: number,
  timers: ThrottleTimers = systemTimers,
): { request: (value: T) => void; flush: () => void; cancel: () => void } {
  let lastCommittedAt = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | null = null;
  let handle: unknown = null;

  function commitNow(value: T): void {
    lastCommittedAt = timers.now();
    commit(value);
  }

  function release(): void {
    handle = null;
    const next = pending;
    pending = null;
    if (next) commitNow(next.value);
  }

  return {
    request(value: T): void {
      const elapsed = timers.now() - lastCommittedAt;
      if (handle === null && elapsed >= intervalMs) {
        commitNow(value);
        return;
      }
      // Inside the window. Keep the newest value and let the existing timer
      // deliver it; replacing the timer on every call would be a debounce, and
      // a caller that never stops would then never write at all.
      pending = { value };
      if (handle === null) {
        handle = timers.setTimeout(release, Math.max(0, intervalMs - elapsed));
      }
    },

    /** Commit whatever is pending now. For a shutdown path. */
    flush(): void {
      if (handle !== null) {
        timers.clearTimeout(handle);
        handle = null;
      }
      const next = pending;
      pending = null;
      if (next) commitNow(next.value);
    },

    /** Drop whatever is pending. For a teardown that must not write. */
    cancel(): void {
      if (handle !== null) {
        timers.clearTimeout(handle);
        handle = null;
      }
      pending = null;
    },
  };
}
