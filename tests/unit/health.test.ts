/**
 * TASK-014. The retry ladder, failover, the no-backup split, and the fact that
 * health is one thing per credential rather than one thing per capability.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CredentialId, ProviderError } from '../../src/shared/types.js';
import {
  CredentialHealth,
  CredentialUnusableError,
  DEGRADED_MAX_BACKOFF_MS,
  MAX_RETRY_ATTEMPTS,
  PROBE_INTERVAL_MS,
  PROBE_PASSES_TO_RECOVER,
  ProviderHealthRegistry,
  RETRY_BACKOFF_MS,
  jittered,
  withinJitterBounds,
} from '../../src/main/ai/health.js';

function err(cls: ProviderError['class'], message = 'failed'): ProviderError {
  const e = new Error(message) as ProviderError;
  e.class = cls;
  e.providerId = 'openai';
  e.retryable = cls !== 'auth' && cls !== 'client';
  return e;
}

/** Records every sleep instead of performing it. */
function testDeps() {
  const slept: number[] = [];
  const intervals: (() => void)[] = [];
  return {
    slept,
    intervals,
    deps: {
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
      setInterval: (fn: () => void) => {
        intervals.push(fn);
        return intervals.length;
      },
      clearInterval: () => undefined,
      // Mid-range, so a jittered value equals its base and assertions stay exact
      // where the ladder is what is under test.
      random: () => 0.5,
    },
  };
}

function health(
  overrides: Partial<{
    hasBackup: boolean;
    probe: () => Promise<boolean>;
    credentialId: CredentialId;
  }> = {},
) {
  const t = testDeps();
  const states: string[] = [];
  const h = new CredentialHealth({
    credentialId: overrides.credentialId ?? 'openai',
    hasBackup: overrides.hasBackup ?? false,
    probe: overrides.probe ?? (() => Promise.resolve(true)),
    onChange: (s) => states.push(s.kind),
    deps: t.deps,
  });
  return { h, states, ...t };
}

/** TC-100: three failures, the ladder, then the backup. */
describe('TC-100 retry then failover', () => {
  it('sleeps 250, 500 and 1000 ms, then switches to the backup', async () => {
    const { h, slept, states } = health({ hasBackup: true });
    const fn = vi
      .fn<(t: string) => Promise<string>>()
      .mockRejectedValueOnce(err('network'))
      .mockRejectedValueOnce(err('server'))
      .mockRejectedValueOnce(err('timeout'))
      .mockRejectedValueOnce(err('network'))
      .mockResolvedValue('from the backup');

    const result = await h.run(fn);

    expect(slept).toEqual(RETRY_BACKOFF_MS);
    expect(result).toBe('from the backup');
    expect(fn.mock.calls.map((c) => c[0])).toEqual([
      'primary',
      'primary',
      'primary',
      'primary',
      'backup',
    ]);
    expect(h.current.kind).toBe('using-backup');
    expect(states).toEqual(['retrying', 'retrying', 'retrying', 'using-backup']);
  });

  it('keeps every backoff inside the jitter bounds', () => {
    for (const base of RETRY_BACKOFF_MS) {
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        expect(withinJitterBounds(base, jittered(base, r))).toBe(true);
      }
      // The bounds are +/- 20 percent, not decorative.
      expect(jittered(base, 0)).toBe(Math.round(base * 0.8));
      expect(jittered(base, 1)).toBe(Math.round(base * 1.2));
      expect(withinJitterBounds(base, Math.round(base * 1.5))).toBe(false);
    }
  });

  it('returns on the first success without sleeping at all', async () => {
    const { h, slept } = health({ hasBackup: true });
    expect(await h.run(() => Promise.resolve('ok'))).toBe('ok');
    expect(slept).toEqual([]);
    expect(h.current.kind).toBe('using-primary');
  });
});

/** TC-101: an auth error skips the ladder entirely. */
describe('TC-101 auth short-circuit', () => {
  it('fails over with zero retry attempts', async () => {
    const { h, slept } = health({ hasBackup: true });
    const fn = vi
      .fn<(t: string) => Promise<string>>()
      .mockRejectedValueOnce(err('auth', 'rejected'))
      .mockResolvedValue('backup');

    expect(await h.run(fn)).toBe('backup');
    expect(slept).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1]?.[0]).toBe('backup');
  });

  it('treats a client error the same way', async () => {
    const { h, slept } = health({ hasBackup: true });
    const fn = vi
      .fn<(t: string) => Promise<string>>()
      .mockRejectedValueOnce(err('client'))
      .mockResolvedValue('backup');
    await h.run(fn);
    expect(slept).toEqual([]);
  });
});

/** TC-102: sticky backup, two passing probes, and the boundary. */
describe('TC-102 sticky backup and recovery', () => {
  async function failedOver(probe: () => Promise<boolean>) {
    const ctx = health({ hasBackup: true, probe });
    await ctx.h.run(
      vi
        .fn<(t: string) => Promise<string>>()
        .mockRejectedValueOnce(err('auth'))
        .mockResolvedValue('backup'),
    );
    return ctx;
  }

  it('stays on the backup for later requests', async () => {
    const { h } = await failedOver(() => Promise.resolve(false));
    const fn = vi.fn<(t: string) => Promise<string>>().mockResolvedValue('still backup');
    await h.run(fn);
    await h.run(fn);
    expect(fn.mock.calls.every((c) => c[0] === 'backup')).toBe(true);
    expect(h.current.kind).toBe('using-backup');
  });

  it('needs two consecutive passes, and one failure resets the count', async () => {
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const { h } = await failedOver(probe);

    await h.runProbe();
    expect(h.hasPendingSwitchBack).toBe(false);
    await h.runProbe();
    expect(h.hasPendingSwitchBack).toBe(false);
    await h.runProbe();
    expect(h.hasPendingSwitchBack).toBe(false);
    await h.runProbe();
    expect(h.hasPendingSwitchBack).toBe(true);
    expect(PROBE_PASSES_TO_RECOVER).toBe(2);
  });

  it('does not switch until a clean boundary, and stays on the backup until then', async () => {
    const { h } = await failedOver(() => Promise.resolve(true));
    await h.runProbe();
    await h.runProbe();
    expect(h.hasPendingSwitchBack).toBe(true);

    // The probes passed, but the switch has not happened: a request right now
    // still goes to the backup, so no socket is closed mid-utterance.
    const fn = vi.fn<(t: string) => Promise<string>>().mockResolvedValue('x');
    await h.run(fn);
    expect(fn.mock.calls[0]?.[0]).toBe('backup');
    expect(h.current.kind).toBe('using-backup');

    expect(h.noteCleanBoundary()).toBe(true);
    expect(h.current.kind).toBe('using-primary');
    await h.run(fn);
    expect(fn.mock.calls[1]?.[0]).toBe('primary');
  });

  it('reports no switch at a boundary when nothing is pending', async () => {
    const { h } = await failedOver(() => Promise.resolve(false));
    expect(h.noteCleanBoundary()).toBe(false);
    expect(h.current.kind).toBe('using-backup');
  });

  it('probes on the documented interval', () => {
    expect(PROBE_INTERVAL_MS).toBe(60_000);
  });
});

/** TC-103 and TC-162: the no-backup split on `retryable` (ADR-024). */
describe('TC-162 no backup splits on retryable', () => {
  it('enters DEGRADED on a retryable failure and keeps retrying, capped at 10 s', async () => {
    const { h, slept } = health({ hasBackup: false });
    const fail = () => Promise.reject(err('network', 'the socket dropped'));

    await expect(h.run(fail)).rejects.toThrow();
    expect(h.current).toEqual({ kind: 'degraded', reason: 'the socket dropped' });
    expect(slept.slice(0, MAX_RETRY_ATTEMPTS)).toEqual(RETRY_BACKOFF_MS);

    // Each further failure backs off more, and stops growing at the cap.
    const seen: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      await expect(h.run(fail)).rejects.toThrow();
      seen.push(h.degradedBackoffMs());
    }
    expect(Math.max(...seen)).toBe(DEGRADED_MAX_BACKOFF_MS);
    expect(seen.at(-1)).toBe(DEGRADED_MAX_BACKOFF_MS);
    // Still trying. DEGRADED is not terminal.
    expect(h.current.kind).toBe('degraded');
    expect(h.isTerminal).toBe(false);
  });

  it('recovers from DEGRADED the moment the primary answers', async () => {
    const { h } = health({ hasBackup: false });
    await expect(h.run(() => Promise.reject(err('server')))).rejects.toThrow();
    expect(h.current.kind).toBe('degraded');

    expect(await h.run(() => Promise.resolve('back'))).toBe('back');
    expect(h.current.kind).toBe('using-primary');
    expect(h.degradedBackoffMs()).toBeLessThanOrEqual(DEGRADED_MAX_BACKOFF_MS);
  });

  it('enters CONFIG_REQUIRED on auth and sends zero further requests', async () => {
    const { h, slept } = health({ hasBackup: false });
    const fn = vi.fn<(t: string) => Promise<string>>().mockRejectedValue(err('auth', 'revoked'));

    await expect(h.run(fn)).rejects.toBeInstanceOf(CredentialUnusableError);
    expect(slept).toEqual([]);
    expect(h.current).toEqual({
      kind: 'config-required',
      credentialId: 'openai',
      reason: 'revoked',
    });
    expect(h.isTerminal).toBe(true);

    // The whole point: a revoked key must not fire a doomed request every ten
    // seconds for an entire interview.
    const callsAfterTerminal = fn.mock.calls.length;
    for (let i = 0; i < 5; i += 1) {
      await expect(h.run(fn)).rejects.toBeInstanceOf(CredentialUnusableError);
    }
    expect(fn).toHaveBeenCalledTimes(callsAfterTerminal);
  });

  it('clears CONFIG_REQUIRED only when the user saves a new key', async () => {
    const { h } = health({ hasBackup: false });
    await expect(h.run(() => Promise.reject(err('auth')))).rejects.toThrow();
    expect(h.isTerminal).toBe(true);

    h.noteKeySaved();
    expect(h.current.kind).toBe('using-primary');
    expect(await h.run(() => Promise.resolve('works now'))).toBe('works now');
  });

  it('goes terminal if a DEGRADED credential is then revoked', async () => {
    const { h } = health({ hasBackup: false });
    await expect(h.run(() => Promise.reject(err('network')))).rejects.toThrow();
    expect(h.current.kind).toBe('degraded');

    await expect(
      h.run(() => Promise.reject(err('auth', 'revoked mid-session'))),
    ).rejects.toBeInstanceOf(CredentialUnusableError);
    expect(h.current.kind).toBe('config-required');
  });

  it('treats an unclassified failure as retryable rather than ending the interview', async () => {
    const { h } = health({ hasBackup: false });
    await expect(h.run(() => Promise.reject(new Error('who knows')))).rejects.toThrow();
    expect(h.current.kind).toBe('degraded');
  });
});

/** TC-143: one credential, one machine, one badge, one probe timer. */
describe('TC-143 health is keyed by credential, not by capability', () => {
  function registry() {
    const t = testDeps();
    const seen: { stt: string; llm: string }[] = [];
    const probes = vi.fn(() => () => Promise.resolve(false));
    const r = new ProviderHealthRegistry(
      (s) => seen.push({ stt: s.stt.kind, llm: s.llm.kind }),
      probes as unknown as (c: CredentialId) => () => Promise<boolean>,
      t.deps,
    );
    // The exact overlap TC-143 describes: OpenAI is the STT *backup* and the
    // LLM primary, so one key serves two capabilities in two different roles.
    r.bind({ capability: 'stt', primary: 'deepgram', backup: 'openai' });
    r.bind({ capability: 'llm', primary: 'openai', backup: null });
    return { r, seen, probes, ...t };
  }

  it('builds one state machine per credential, whatever role it plays', () => {
    const { r } = registry();
    // deepgram and openai, not one per capability-role pairing.
    expect(r.credentialCount).toBe(2);
    expect(r.get('openai')).toBe(r.for('llm'));
    expect(r.get('openai')).not.toBe(r.for('stt'));
    // The STT backup has a machine before it is ever used, so a revoked backup
    // key is visible before the primary fails rather than after.
    expect(r.get('openai')).not.toBeNull();
  });

  it('names both capabilities for one rejected key', async () => {
    const { r, seen } = registry();
    await expect(r.runFor('llm', () => Promise.reject(err('auth', 'revoked')))).rejects.toThrow();

    // One credential in CONFIG_REQUIRED, and both capabilities report it with
    // the same credentialId, so the Dashboard renders one badge naming both.
    expect(r.capabilitiesFor('openai').sort()).toEqual(['llm', 'stt']);
    const snapshot = r.snapshot();
    expect(snapshot.stt).toEqual(snapshot.llm);
    expect(snapshot.llm).toEqual({
      kind: 'config-required',
      credentialId: 'openai',
      reason: 'revoked',
    });
    // CH-202 reflected the transition rather than waiting for a poll.
    expect(seen.at(-1)).toEqual({ stt: 'config-required', llm: 'config-required' });
  });

  it('runs one probe timer per credential, not one per capability', async () => {
    const { r, intervals } = registry();
    // 'stt' has a backup, so a failure on its primary starts one probe timer.
    await r.runFor(
      'stt',
      vi
        .fn<(t: string) => Promise<string>>()
        .mockRejectedValueOnce(err('auth'))
        .mockResolvedValue('backup'),
    );
    expect(intervals).toHaveLength(1);
    expect(r.for('stt').current.kind).toBe('using-backup');
  });

  it('does not fail a capability over to a backup it does not have', async () => {
    const { r } = registry();
    // The same OpenAI credential is the STT backup, which has a backup path,
    // and the LLM primary, which does not. The LLM must go terminal rather
    // than fail over to a backup that exists only for the other capability.
    await expect(
      r.runFor('llm', () => Promise.reject(err('auth', 'revoked'))),
    ).rejects.toBeInstanceOf(CredentialUnusableError);
    expect(r.get('openai')?.current.kind).toBe('config-required');
  });

  it('keeps a revoked key flagged even where another capability routes around it', async () => {
    const { r } = registry();
    await expect(r.runFor('llm', () => Promise.reject(err('auth', 'revoked')))).rejects.toThrow();

    // STT still works: its primary is deepgram. But the badge must stay up,
    // because the key STT would fail over to is revoked.
    expect(r.snapshot().stt.kind).toBe('config-required');
    expect(r.snapshot().llm.kind).toBe('config-required');
  });

  it('clears only the credential whose key was saved', async () => {
    const t = testDeps();
    const r = new ProviderHealthRegistry(
      () => undefined,
      () => () => Promise.resolve(false),
      t.deps,
    );
    r.bind({ capability: 'stt', primary: 'deepgram', backup: null });
    r.bind({ capability: 'llm', primary: 'anthropic', backup: null });

    await expect(r.runFor('stt', () => Promise.reject(err('auth')))).rejects.toThrow();
    await expect(r.runFor('llm', () => Promise.reject(err('auth')))).rejects.toThrow();
    expect(r.credentialCount).toBe(2);

    r.noteKeySaved('deepgram');
    expect(r.snapshot().stt.kind).toBe('using-primary');
    expect(r.snapshot().llm.kind).toBe('config-required');
  });

  it('switches back every pending credential at one boundary', async () => {
    const t = testDeps();
    const r = new ProviderHealthRegistry(
      () => undefined,
      () => () => Promise.resolve(true),
      t.deps,
    );
    r.bind({ capability: 'stt', primary: 'deepgram', backup: 'elevenlabs' });
    await r.runFor(
      'stt',
      vi
        .fn<(t: string) => Promise<string>>()
        .mockRejectedValueOnce(err('auth'))
        .mockResolvedValue('b'),
    );
    const h = r.for('stt');
    await h.runProbe();
    await h.runProbe();

    expect(r.noteCleanBoundary()).toEqual(['deepgram']);
    expect(r.snapshot().stt.kind).toBe('using-primary');
    // Idempotent: a second boundary with nothing pending switches nothing.
    expect(r.noteCleanBoundary()).toEqual([]);
  });

  it('reports a healthy default for a capability nothing is bound to', () => {
    const r = new ProviderHealthRegistry(
      () => undefined,
      () => () => Promise.resolve(true),
    );
    expect(r.snapshot()).toEqual({
      stt: { kind: 'using-primary' },
      llm: { kind: 'using-primary' },
    });
    expect(() => r.for('stt')).toThrow(/No credential is bound/);
    r.dispose();
  });
});

/** TC-144: the switch-back never lands while audio is still in flight. */
describe('TC-144 the STT switch-back boundary', () => {
  async function pendingSwitchBack() {
    const t = testDeps();
    const r = new ProviderHealthRegistry(
      () => undefined,
      () => () => Promise.resolve(true),
      t.deps,
    );
    r.bind({ capability: 'stt', primary: 'deepgram', backup: 'elevenlabs' });
    await r.runFor(
      'stt',
      vi
        .fn<(t: string) => Promise<string>>()
        .mockRejectedValueOnce(err('auth'))
        .mockResolvedValue('b'),
    );
    const h = r.for('stt');
    await h.runProbe();
    await h.runProbe();
    expect(h.hasPendingSwitchBack).toBe(true);
    return { r, h };
  }

  it('refuses a boundary while chunks are still in flight', async () => {
    const { r, h } = await pendingSwitchBack();

    expect(r.noteCleanBoundary({ audioInFlight: 2 })).toEqual([]);
    expect(h.current.kind).toBe('using-backup');
    // The switch is still owed, not cancelled.
    expect(h.hasPendingSwitchBack).toBe(true);

    expect(r.noteCleanBoundary({ audioInFlight: 1 })).toEqual([]);
    expect(h.current.kind).toBe('using-backup');
  });

  it('switches once the last chunk has drained', async () => {
    const { r, h } = await pendingSwitchBack();
    expect(r.noteCleanBoundary({ audioInFlight: 0 })).toEqual(['deepgram']);
    expect(h.current.kind).toBe('using-primary');
    expect(h.hasPendingSwitchBack).toBe(false);
  });

  it('keeps serving from the backup across the whole wait, losing no turn', async () => {
    const { r, h } = await pendingSwitchBack();
    const fn = vi.fn<(t: string) => Promise<string>>().mockResolvedValue('transcript');

    // Audio in flight: the request still goes somewhere, and that somewhere is
    // the backup. Nothing is dropped while the switch waits.
    r.noteCleanBoundary({ audioInFlight: 3 });
    expect(await r.runFor('stt', fn)).toBe('transcript');
    expect(fn.mock.calls[0]?.[0]).toBe('backup');

    r.noteCleanBoundary({ audioInFlight: 0 });
    expect(await r.runFor('stt', fn)).toBe('transcript');
    expect(fn.mock.calls[1]?.[0]).toBe('primary');
    expect(h.current.kind).toBe('using-primary');
  });
});
