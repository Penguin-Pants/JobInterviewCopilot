import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttleWrites, type ThrottleTimers } from '../../src/main/write-throttle.js';

/**
 * TASK-043. The rate limit in front of `CH-126 overlay:setFontSize`.
 *
 * Driven with fake timers against an injected clock, so the behaviour is
 * asserted rather than waited for. The property that matters is the one a
 * compromised overlay renderer would try to break: any number of calls inside
 * one window costs one write, and the value that lands is the last one asked
 * for.
 */

function fakeTimers(): ThrottleTimers & { advance: (ms: number) => void } {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    advance: (ms: number) => vi.advanceTimersByTime(ms),
  };
}

describe('throttleWrites', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('commits the first request immediately, so one press feels immediate', () => {
    const written: number[] = [];
    const timers = fakeTimers();
    const t = throttleWrites<number>((v) => written.push(v), 200, timers);

    t.request(24);
    expect(written).toEqual([24]);
  });

  /**
   * The attack the limit exists for: a renderer alternating two values as fast
   * as it can. Every call used to reach `config.set`, which is a synchronous
   * settings write on the process that runs the live audio and STT loop.
   */
  it('costs one write however many calls arrive inside the window', () => {
    const written: number[] = [];
    const timers = fakeTimers();
    const t = throttleWrites<number>((v) => written.push(v), 200, timers);

    t.request(16);
    expect(written).toEqual([16]);

    for (let i = 0; i < 5000; i += 1) t.request(i % 2 === 0 ? 32 : 16);
    // Not one of those 5000 has been written: the window is still open.
    expect(written).toEqual([16]);

    timers.advance(200);
    // Exactly one more, and it is the last value asked for.
    expect(written).toEqual([16, 16]);
  });

  it('commits the newest value when the window closes, not the oldest', () => {
    const written: number[] = [];
    const timers = fakeTimers();
    const t = throttleWrites<number>((v) => written.push(v), 200, timers);

    t.request(16);
    t.request(20);
    t.request(28);
    t.request(30);
    timers.advance(200);
    expect(written).toEqual([16, 30]);
  });

  /**
   * A debounce would restart its timer on every call, so a caller that never
   * stops would never write at all and the control would appear dead. The
   * trailing commit fires on the window it was scheduled in.
   */
  it('still writes under a caller that never stops', () => {
    const written: number[] = [];
    const timers = fakeTimers();
    const t = throttleWrites<number>((v) => written.push(v), 200, timers);

    for (let round = 0; round < 4; round += 1) {
      for (let i = 0; i < 50; i += 1) t.request(round);
      timers.advance(200);
    }
    // One write to open, then one per window: bounded, and never zero.
    expect(written.length).toBeLessThanOrEqual(5);
    expect(written.length).toBeGreaterThanOrEqual(4);
  });

  it('a request after the window has passed commits immediately again', () => {
    const written: number[] = [];
    const timers = fakeTimers();
    const t = throttleWrites<number>((v) => written.push(v), 200, timers);

    t.request(24);
    timers.advance(500);
    t.request(26);
    expect(written).toEqual([24, 26]);
  });

  it('flush commits what is pending and cancels the timer', () => {
    const written: number[] = [];
    const timers = fakeTimers();
    const t = throttleWrites<number>((v) => written.push(v), 200, timers);

    t.request(24);
    t.request(30);
    t.flush();
    expect(written).toEqual([24, 30]);

    timers.advance(500);
    expect(written).toEqual([24, 30]);
  });

  it('cancel drops what is pending and writes nothing', () => {
    const written: number[] = [];
    const timers = fakeTimers();
    const t = throttleWrites<number>((v) => written.push(v), 200, timers);

    t.request(24);
    t.request(30);
    t.cancel();
    timers.advance(500);
    expect(written).toEqual([24]);
  });

  it('flush and cancel on an idle throttle do nothing', () => {
    const written: number[] = [];
    const timers = fakeTimers();
    const t = throttleWrites<number>((v) => written.push(v), 200, timers);

    t.flush();
    t.cancel();
    expect(written).toEqual([]);
  });
});
