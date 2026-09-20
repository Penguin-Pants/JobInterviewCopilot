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

const dir = () => mkdtempSync(join(tmpdir(), 'stt-catalog-'));
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('STT runtime catalog', () => {
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
    const catalog = new SttCatalogService({ dir: dir(), keyFor: () => 'secret', fetch: fetcher });
    const result = await catalog.get();
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }),
    );
    expect(
      result.providers.find((p) => p.providerId === 'openai')?.models.map((m) => m.id),
    ).toEqual(['gpt-4o-transcribe']);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

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

  it('preserves the last good cache after malformed, empty, and failed refreshes', async () => {
    const root = dir();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [{ id: 'whisper-1' }] }))
      .mockResolvedValueOnce(response({ nope: [] }))
      .mockRejectedValueOnce(new Error('offline'));
    const catalog = new SttCatalogService({ dir: root, keyFor: () => 'key', fetch: fetcher });
    await catalog.get(true);
    expect((await catalog.get(true)).providers.find((p) => p.providerId === 'openai')?.state).toBe(
      'stale',
    );
    expect(
      (await catalog.get(true)).providers.find((p) => p.providerId === 'openai')?.models[0]?.id,
    ).toBe('whisper-1');
    expect(
      JSON.parse(readFileSync(join(root, 'stt-catalog.json'), 'utf8')).providers.openai.models[0]
        .id,
    ).toBe('whisper-1');
  });

  it('sorts deterministically and only classifies policy entries', () => {
    expect(compatibleModel('openai', 'new-transcribe')).toBeNull();
    const a = compatibleModel('openai', 'whisper-1')!;
    const b = compatibleModel('openai', 'gpt-4o-transcribe')!;
    a.catalogStatus = 'legacy';
    b.catalogStatus = 'available';
    expect(sortCatalogModels([a, b]).map((m) => m.id)).toEqual(['gpt-4o-transcribe', 'whisper-1']);
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

  it('bounds a stalled discovery request and returns fallback data', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
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
});
