/**
 * TASK-053. The runtime speech-to-text catalog (FR-116, FR-117, FR-118).
 *
 * One `describe` per test case in `docs/04-test-strategy.md`, TC-192 to
 * TC-198, so each row can be found by its id.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  STT_CATALOG_MAX_AGE_MS,
  STT_CATALOG_REQUEST_TIMEOUT_MS,
  SttCatalogService,
  compatibleModel,
  sortCatalogModels,
} from '../../src/main/stt-catalog.js';
import {
  createSttCatalogLoader,
  type SttCatalogUpdate,
} from '../../src/renderer/dashboard/sections/ProviderSetup.js';
import type { CallResult } from '../../src/renderer/dashboard/call.js';
import type { SttCatalogSnapshot } from '../../src/shared/types.js';

const dir = () => mkdtempSync(join(tmpdir(), 'stt-catalog-'));
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('TC-192 account filtering and authentication', () => {
  it('authenticates OpenAI and rejects unrelated and unknown models', async () => {
    const fetcher = vi.fn(async () =>
      response({
        data: [
          { id: 'gpt-4o-transcribe', created: 10 },
          { id: 'gpt-4.1' },
          { id: 'future-transcribe' },
        ],
      }),
    );
    const root = dir();
    const catalog = new SttCatalogService({ dir: root, keyFor: () => 'secret', fetch: fetcher });
    const result = await catalog.get();
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }),
    );
    expect(
      result.providers.find((p) => p.providerId === 'openai')?.models.map((m) => m.id),
    ).toEqual(['gpt-4o-transcribe']);
    // Neither the answer the renderer receives nor the cache on disk carries
    // the credential it was fetched with.
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(readFileSync(join(root, 'stt-catalog.json'), 'utf8')).not.toContain('secret');
  });

  it('does not fetch without a key', async () => {
    const fetcher = vi.fn();
    const result = await new SttCatalogService({
      dir: dir(),
      keyFor: () => undefined,
      fetch: fetcher,
    }).get();
    expect(result.providers.every((p) => p.state === 'missing-key')).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sorts deterministically and only classifies policy entries', () => {
    expect(compatibleModel('openai', 'new-transcribe')).toBeNull();
    const a = compatibleModel('openai', 'whisper-1')!;
    const b = compatibleModel('openai', 'gpt-4o-transcribe')!;
    a.catalogStatus = 'legacy';
    b.catalogStatus = 'available';
    expect(sortCatalogModels([a, b]).map((m) => m.id)).toEqual(['gpt-4o-transcribe', 'whisper-1']);
  });
});

describe('TC-193 fallback lifecycle semantics', () => {
  it('uses explicit shipped fallback for providers without a safe entitlement endpoint', async () => {
    const fetcher = vi.fn();
    const result = await new SttCatalogService({
      dir: dir(),
      keyFor: () => 'key',
      fetch: fetcher,
    }).get();
    expect(result.providers.find((p) => p.providerId === 'deepgram')?.state).toBe('fallback');
    expect(result.providers.find((p) => p.providerId === 'elevenlabs')?.source).toBe('fallback');
    expect(
      result.providers.find((p) => p.providerId === 'deepgram')?.models[0]?.catalogStatus,
    ).toBe('available');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('TC-194 cache time boundaries', () => {
  it('uses a fresh cache and refreshes at exactly 28 days', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const fetcher = vi.fn(async () => response({ data: [{ id: 'whisper-1' }] }));
    const catalog = new SttCatalogService({
      dir: dir(),
      keyFor: () => 'key',
      fetch: fetcher,
      now: () => now,
    });
    await catalog.get();
    await catalog.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += STT_CATALOG_MAX_AGE_MS;
    await catalog.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not treat a future cache timestamp as fresh', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const fetcher = vi.fn(async () => response({ data: [{ id: 'whisper-1' }] }));
    const root = dir();
    const catalog = new SttCatalogService({
      dir: root,
      keyFor: () => 'key',
      fetch: fetcher,
      now: () => now,
    });
    await catalog.get();
    now -= 1;
    await catalog.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('TC-195 cache policy revalidation', () => {
  it('rebuilds cached capabilities from the current compatibility policy', async () => {
    const root = dir();
    writeFileSync(
      join(root, 'stt-catalog.json'),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          openai: {
            refreshedAt: '2026-01-01T00:00:00.000Z',
            models: [
              {
                ...compatibleModel('openai', 'whisper-1'),
                displayName: 'stale',
                streaming: true,
                pricePerAudioMinuteUsd: 999,
              },
            ],
          },
        },
      }),
    );
    const result = await new SttCatalogService({
      dir: root,
      keyFor: () => 'key',
      now: () => Date.parse('2026-01-02T00:00:00.000Z'),
    }).get();
    const model = result.providers.find((p) => p.providerId === 'openai')?.models[0];
    expect(model).toMatchObject({
      displayName: 'Whisper (batched)',
      streaming: false,
      pricePerAudioMinuteUsd: 0.006,
    });
  });
});

describe('TC-196 credential replacement race', () => {
  it('does not publish a response started with a replaced credential', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const root = dir();
    const catalog = new SttCatalogService({ dir: root, keyFor: () => 'key', fetch: fetcher });
    const pending = catalog.get(true);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    catalog.invalidate('openai');
    finish(response({ data: [{ id: 'whisper-1' }] }));
    const result = await pending;
    expect(result.providers.find((p) => p.providerId === 'openai')?.state).toBe('stale');
    expect(
      JSON.parse(readFileSync(join(root, 'stt-catalog.json'), 'utf8')).providers.openai,
    ).toBeUndefined();
  });

  it('does not trust an old-account cache after restart', async () => {
    const root = dir();
    let version = '11111111-1111-4111-8111-111111111111';
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [{ id: 'whisper-1' }] }))
      .mockResolvedValueOnce(response({ data: [{ id: 'gpt-4o-transcribe' }] }));
    await new SttCatalogService({
      dir: root,
      keyFor: () => 'key-a',
      credentialVersionFor: () => version,
      fetch: fetcher,
    }).get();
    version = '22222222-2222-4222-8222-222222222222';
    const result = await new SttCatalogService({
      dir: root,
      keyFor: () => 'key-b',
      credentialVersionFor: () => version,
      fetch: fetcher,
    }).get();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.providers.find((p) => p.providerId === 'openai')?.models[0]?.id).toBe(
      'gpt-4o-transcribe',
    );
  });
});

describe('TC-197 discovery deadline', () => {
  /** A fetch that never answers, and rejects only when its signal aborts. */
  const stalled = (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });

  it('bounds a stalled discovery request and returns fallback data', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(stalled);
      const pending = new SttCatalogService({
        dir: dir(),
        keyFor: () => 'key',
        fetch: fetcher as typeof fetch,
      }).get(true);
      await vi.advanceTimersByTimeAsync(STT_CATALOG_REQUEST_TIMEOUT_MS);
      const result = await pending;
      expect(result.providers.find((p) => p.providerId === 'openai')?.state).toBe('fallback');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled refresh and keeps the last known good catalog', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(response({ data: [{ id: 'gpt-4o-transcribe' }] }))
        .mockImplementationOnce(stalled);
      const catalog = new SttCatalogService({ dir: dir(), keyFor: () => 'key', fetch: fetcher });
      await catalog.get(true);
      const pending = catalog.get(true);
      await vi.advanceTimersByTimeAsync(STT_CATALOG_REQUEST_TIMEOUT_MS);
      const openai = (await pending).providers.find((p) => p.providerId === 'openai');
      expect(openai?.state).toBe('stale');
      expect(openai?.source).toBe('account');
      expect(openai?.models.map((m) => m.id)).toEqual(['gpt-4o-transcribe']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TC-198 failure preservation and ordering', () => {
  it('preserves the last good cache after malformed, empty, and failed refreshes', async () => {
    const root = dir();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [{ id: 'whisper-1' }] }))
      .mockResolvedValueOnce(response({ nope: [] }))
      .mockResolvedValueOnce(response({ data: [] }))
      .mockRejectedValueOnce(new Error('offline'));
    const catalog = new SttCatalogService({ dir: root, keyFor: () => 'key', fetch: fetcher });
    await catalog.get(true);
    for (let failure = 0; failure < 3; failure += 1) {
      const openai = (await catalog.get(true)).providers.find((p) => p.providerId === 'openai');
      expect(openai?.state).toBe('stale');
      expect(openai?.models[0]?.id).toBe('whisper-1');
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(
      JSON.parse(readFileSync(join(root, 'stt-catalog.json'), 'utf8')).providers.openai.models[0]
        .id,
    ).toBe('whisper-1');
  });

  it('returns the newest cache when an older overlapping refresh fails', async () => {
    let rejectOld!: (reason: Error) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [{ id: 'whisper-1' }] }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValueOnce(response({ data: [{ id: 'gpt-4o-transcribe' }] }));
    const catalog = new SttCatalogService({ dir: dir(), keyFor: () => 'key', fetch: fetcher });
    await catalog.get(true);
    const old = catalog.get(true);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await catalog.get(true);
    rejectOld(new Error('offline'));
    const result = await old;
    expect(result.providers.find((p) => p.providerId === 'openai')?.models[0]?.id).toBe(
      'gpt-4o-transcribe',
    );
  });

  describe('the Provider Setup loader', () => {
    const snapshot = (modelId: string): SttCatalogSnapshot => ({
      providers: [
        {
          providerId: 'openai',
          displayName: 'OpenAI',
          source: 'account',
          state: 'ready',
          lastSuccessfulRefresh: null,
          models: [compatibleModel('openai', modelId)!],
        },
      ],
    });

    /** Requests the test settles by hand, in whatever order it chooses. */
    function harness() {
      const answers: ((result: CallResult<'catalog:stt'>) => void)[] = [];
      const updates: SttCatalogUpdate[] = [];
      const load = createSttCatalogLoader(
        () =>
          new Promise((resolve) => {
            answers.push(resolve);
          }),
        (update) => updates.push(update),
      );
      return { load, answers, updates };
    }

    it('drops a superseded answer that settles after the newer one', async () => {
      const { load, answers, updates } = harness();
      const first = load();
      const refresh = load(true);
      answers[1]?.({ ok: true, value: snapshot('gpt-4o-transcribe') });
      await refresh;
      answers[0]?.({ ok: true, value: snapshot('whisper-1') });
      await first;
      expect(updates).toEqual([
        { kind: 'loading' },
        { kind: 'loading' },
        { kind: 'loaded', catalog: snapshot('gpt-4o-transcribe') },
      ]);
    });

    it('drops a superseded failure so it cannot mask newer usable state', async () => {
      const { load, answers, updates } = harness();
      const first = load();
      const refresh = load(true);
      answers[1]?.({ ok: true, value: snapshot('whisper-1') });
      await refresh;
      answers[0]?.({ ok: false, message: 'offline' });
      await first;
      expect(updates.at(-1)).toEqual({ kind: 'loaded', catalog: snapshot('whisper-1') });
    });

    it('reports a current failure without a catalog, so the one shown stays', async () => {
      const { load, answers, updates } = harness();
      const first = load();
      answers[0]?.({ ok: true, value: snapshot('whisper-1') });
      await first;
      const refresh = load(true);
      answers[1]?.({ ok: false, message: 'offline' });
      await refresh;
      expect(updates).toEqual([
        { kind: 'loading' },
        { kind: 'loaded', catalog: snapshot('whisper-1') },
        { kind: 'loading' },
        { kind: 'failed', message: 'offline' },
      ]);
    });
  });
});
