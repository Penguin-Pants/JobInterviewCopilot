/**
 * The overlay's calls to the main process (CMP-14, FR-008, FR-081).
 *
 * The overlay has no DOM in this suite, so each rule is asserted on the module
 * the component calls: `invoke.ts` for failures and the readiness retry, and
 * `sizeRequests.ts` for the resize grip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeLogged, reportReady, retryWithBackoff } from '../../src/renderer/overlay/invoke.js';
import { createSizeRequests, type Size } from '../../src/renderer/overlay/sizeRequests.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubInvoke(answer: () => Promise<unknown>): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(answer);
  vi.stubGlobal('window', { copilot: { invoke } });
  return invoke;
}

describe('an overlay call that fails is reported, not swallowed', () => {
  it('reports success for an ok answer and logs nothing', async () => {
    stubInvoke(async () => ({ ok: true }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(invokeLogged('overlay:ready')).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs an IpcError answer with its channel and reports failure', async () => {
    stubInvoke(async () => ({ __ipcError: true, channel: 'overlay:ready', message: 'no gate' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(invokeLogged('overlay:ready')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlay:ready'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no gate'));
  });

  it('logs a rejection rather than leaving it unhandled', async () => {
    stubInvoke(async () => {
      throw new Error('Channel is not exposed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(invokeLogged('consent:dismiss')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Channel is not exposed'));
  });
});

describe('readiness is retried, because without it no suggestion arrives (FR-008)', () => {
  const noWait = (delays: number[]) => async (ms: number) => {
    delays.push(ms);
  };

  it('retries a failed report with a growing delay until it succeeds', async () => {
    const delays: number[] = [];
    const attempt = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const ok = await retryWithBackoff(attempt, {
      attempts: 5,
      firstDelayMs: 100,
      wait: noWait(delays),
    });
    expect(ok).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it('stops after a bounded number of attempts', async () => {
    const delays: number[] = [];
    const attempt = vi.fn(async () => false);
    const ok = await retryWithBackoff(attempt, {
      attempts: 4,
      firstDelayMs: 100,
      wait: noWait(delays),
    });
    expect(ok).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  it('stops when the report it belongs to is superseded', async () => {
    let cancelled = false;
    const attempt = vi.fn(async () => {
      cancelled = true;
      return false;
    });
    const ok = await retryWithBackoff(attempt, {
      attempts: 5,
      firstDelayMs: 100,
      wait: async () => undefined,
      cancelled: () => cancelled,
    });
    expect(ok).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

/**
 * FR-006, FR-008, ADR-016. A readiness report names the session it is for, and
 * a retry stops the moment a newer `state:session` push names another one. A
 * retry left running reached the main process after it had closed the gate for
 * the next interview, before the renewed reminder had painted.
 */
describe('readiness is reported for one session only (FR-008)', () => {
  it('names the session in every attempt', async () => {
    const invoke = stubInvoke(async () => ({ ok: true }));
    await reportReady('session-1', {
      attempts: 3,
      firstDelayMs: 100,
      wait: async () => undefined,
      latestSessionId: () => 'session-1',
    });
    expect(invoke).toHaveBeenCalledWith('overlay:ready', { sessionId: 'session-1' });
  });

  it('stops retrying once a newer push names another session', async () => {
    let latest: string | null = 'session-1';
    const invoke = stubInvoke(async () => {
      // The next session's push lands while this attempt is answered.
      latest = 'session-2';
      return { __ipcError: true, channel: 'overlay:ready', message: 'stale' };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = await reportReady('session-1', {
      attempts: 5,
      firstDelayMs: 100,
      wait: async () => undefined,
      latestSessionId: () => latest,
    });
    expect(ok).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not retry a report the main process refused for another session', async () => {
    const invoke = stubInvoke(async () => ({ refused: 'another-session' }));
    const ok = await reportReady(null, {
      attempts: 5,
      firstDelayMs: 100,
      wait: async () => undefined,
      latestSessionId: () => null,
    });
    expect(ok).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a session that has already ended', async () => {
    const invoke = stubInvoke(async () => ({ ok: true }));
    const ok = await reportReady('session-1', {
      attempts: 5,
      firstDelayMs: 100,
      wait: async () => undefined,
      latestSessionId: () => null,
    });
    expect(ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('the resize grip sends one size at a time and loses no key press (FR-081)', () => {
  function harness(start: Size) {
    let window = start;
    const frames: (() => void)[] = [];
    const sent: Size[] = [];
    const answers: (() => void)[] = [];
    const requests = createSizeRequests({
      send: (size) =>
        new Promise<void>((resolve) => {
          sent.push(size);
          answers.push(resolve);
        }),
      nextFrame: (callback) => frames.push(callback),
      current: () => window,
    });
    const frame = (): void => {
      for (const callback of frames.splice(0)) callback();
    };
    const resizeTo = (size: Size): void => {
      window = size;
      requests.onWindowResize();
    };
    return { requests, sent, answers, frame, resizeTo };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('sends only the newest of the sizes asked for in one frame', () => {
    const { requests, sent, frame } = harness({ width: 600, height: 300 });
    requests.request({ width: 610, height: 300 });
    requests.request({ width: 620, height: 300 });
    requests.request({ width: 630, height: 300 });
    frame();
    expect(sent).toEqual([{ width: 630, height: 300 }]);
  });

  it('holds a newer size while one is in flight, then sends it', async () => {
    const { requests, sent, answers, frame } = harness({ width: 600, height: 300 });
    requests.request({ width: 610, height: 300 });
    frame();
    requests.request({ width: 620, height: 300 });
    frame();
    expect(sent).toHaveLength(1);
    answers[0]?.();
    await settle();
    frame();
    expect(sent).toEqual([
      { width: 610, height: 300 },
      { width: 620, height: 300 },
    ]);
  });

  it('steps from the size last asked for, not from a window that has not caught up', () => {
    const { requests } = harness({ width: 600, height: 300 });
    requests.request({ width: 620, height: 300 });
    // The window is still 600 wide: the resize has not landed yet.
    expect(requests.base()).toEqual({ width: 620, height: 300 });
  });

  it('ignores a resize that lands while a request is still in flight', () => {
    const { requests, frame, resizeTo } = harness({ width: 600, height: 300 });
    requests.request({ width: 620, height: 300 });
    frame();
    requests.request({ width: 640, height: 300 });
    resizeTo({ width: 620, height: 300 });
    expect(requests.base()).toEqual({ width: 640, height: 300 });
  });

  it('follows the window again once nothing is pending, so a clamp is believed', async () => {
    const { requests, answers, frame, resizeTo } = harness({ width: 600, height: 300 });
    requests.request({ width: 620, height: 300 });
    frame();
    answers[0]?.();
    await settle();
    resizeTo({ width: 610, height: 300 });
    expect(requests.base()).toEqual({ width: 610, height: 300 });
  });

  it('follows the window a frame after the last answer, even with no resize event', async () => {
    const { requests, answers, frame } = harness({ width: 600, height: 300 });
    requests.request({ width: 620, height: 300 });
    frame();
    answers[0]?.();
    await settle();
    frame();
    expect(requests.base()).toEqual({ width: 600, height: 300 });
  });
});
