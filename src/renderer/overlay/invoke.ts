/**
 * The overlay's calls to the main process (CMP-14, CMP-10).
 *
 * Every call here was `void window.copilot.invoke(...)`. That drops an
 * `IpcError` answer without a word and leaves a rejection unhandled, so a
 * failed `overlay:ready` looked exactly like a sent one. That one matters most:
 * the main process holds every suggestion until readiness arrives, so a lost
 * report meant no suggestion reached the user for the whole session (FR-008,
 * `earlyPushes.ts`).
 *
 * The overlay has no error state by design (FR-076), so a failure goes to the
 * console and is never shown. The message is the main process's own text,
 * which carries no key, audio or path.
 */
import { call } from '../dashboard/call.js';
import type { InvokeChannel, InvokePayload } from '../../shared/ipc.js';

/** Sends one call and logs a failure. True when the main process answered ok. */
export async function invokeLogged<C extends InvokeChannel>(
  channel: C,
  payload?: InvokePayload<C>,
): Promise<boolean> {
  const result = await call(channel, payload);
  if (!result.ok) console.warn(`[overlay] ${channel} failed: ${result.message}`);
  return result.ok;
}

export interface RetryOptions {
  /** Attempts in total, the first one included. */
  attempts: number;
  /** The wait before the second attempt. Each later wait doubles it. */
  firstDelayMs: number;
  wait?: (ms: number) => Promise<void>;
  /** True once the result is no longer wanted, such as a superseded report. */
  cancelled?: () => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until it succeeds, is cancelled or runs out of attempts.
 *
 * Bounded, because a main process that refuses every time will not change its
 * answer, and a renderer that retried forever would only fill the log.
 */
export async function retryWithBackoff(
  attempt: () => Promise<boolean>,
  { attempts, firstDelayMs, wait = sleep, cancelled = () => false }: RetryOptions,
): Promise<boolean> {
  let delay = firstDelayMs;
  for (let tried = 1; ; tried += 1) {
    if (cancelled()) return false;
    if (await attempt()) return true;
    if (tried >= attempts || cancelled()) return false;
    await wait(delay);
    delay *= 2;
  }
}

export interface ReadyReportOptions extends RetryOptions {
  /** The `sessionId` of the newest `state:session` push, read at each attempt. */
  latestSessionId: () => string | null;
}

/**
 * Reports `overlay:ready` for one session, retried while it is still wanted
 * (FR-006, FR-008, ADR-016).
 *
 * The report names its session, and the retry stops the moment a newer
 * `state:session` push names another one. The React cleanup that cancels a
 * superseded report runs only after the renderer has rendered the push, and a
 * retry that fired before that reached the main process after it had closed
 * the gate for the next interview, before the renewed reminder had painted.
 * The main process refuses such a report too. A refusal is final, because
 * the main process has moved on from that session and will not move back.
 */
export async function reportReady(
  sessionId: string | null,
  { latestSessionId, cancelled = () => false, ...retry }: ReadyReportOptions,
): Promise<boolean> {
  let refused = false;
  return retryWithBackoff(
    async () => {
      const result = await call('overlay:ready', { sessionId });
      if (!result.ok) {
        console.warn(`[overlay] overlay:ready failed: ${result.message}`);
        return false;
      }
      refused = 'refused' in result.value;
      return !refused;
    },
    { ...retry, cancelled: () => cancelled() || refused || latestSessionId() !== sessionId },
  );
}
