import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  STT_CATALOG_MAX_AGE_MS,
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
    expect(fetcher).toHaveBeenCalledWith('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer secret' },
    });
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
});
