import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_MAX_AGE_MS,
  LlmCatalogService,
  anthropicCompatibility,
  openAiCompatibility,
} from '../../src/main/ai/llm/catalog.js';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('runtime LLM catalog', () => {
  it('uses conservative centralized compatibility rules', () => {
    expect(openAiCompatibility({ id: 'gpt-4o-mini' })).toBeNull();
    expect(openAiCompatibility({ id: 'gpt-5' })).toEqual({
      allowed: ['minimal', 'low', 'medium', 'high'],
      default: 'medium',
    });
    for (const id of [
      'text-embedding-3-small',
      'gpt-4o-transcribe',
      'gpt-image-1',
      'omni-moderation-latest',
      'gpt-realtime',
      'ft:gpt-4o:account:x',
    ]) {
      expect(openAiCompatibility({ id })).toBe(false);
    }
    expect(openAiCompatibility({ id: 'gpt-99-new' })).toBe(false);
    expect(anthropicCompatibility('claude-haiku-4-5-20251001')).toBe(false);
    expect(anthropicCompatibility('claude-sonnet-4-6')).toEqual({
      allowed: ['low', 'medium', 'high'],
      default: 'high',
    });
  });

  it('authenticates, follows Anthropic pagination, sorts, and writes an atomic cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-catalog-'));
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('openai.com')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer open-key');
        return response({
          object: 'list',
          data: [
            { id: 'gpt-4o-mini', object: 'model', created: 1 },
            { id: 'text-embedding-3-small', object: 'model', created: 2 },
          ],
        });
      }
      expect(new Headers(init?.headers).get('x-api-key')).toBe('anth-key');
      expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
      return url.includes('after_id=one')
        ? response({
            data: [
              {
                id: 'claude-opus-4-6',
                display_name: 'Claude Opus 4.6',
                created_at: '2026-02-05T00:00:00.000Z',
              },
            ],
            has_more: false,
          })
        : response({
            data: [
              {
                id: 'claude-sonnet-4-5-20250929',
                display_name: 'Claude Sonnet 4.5',
                created_at: '2025-09-29T00:00:00.000Z',
              },
            ],
            has_more: true,
            last_id: 'one',
          });
    });
    const service = new LlmCatalogService({
      dir,
      fetch: fetcher as typeof fetch,
      keyFor: (provider) => (provider === 'openai' ? 'open-key' : 'anth-key'),
      now: () => CATALOG_MAX_AGE_MS,
    });
    const catalog = await service.refresh();
    expect(
      catalog.providers.find((p) => p.providerId === 'openai')?.models.map((m) => m.id),
    ).toEqual(['gpt-4o-mini']);
    expect(
      catalog.providers.find((p) => p.providerId === 'anthropic')?.models.map((m) => m.id),
    ).toEqual(['claude-opus-4-6', 'claude-sonnet-4-5-20250929']);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(readFileSync(join(dir, 'llm-catalog.json'), 'utf8')).schemaVersion).toBe(1);
  });

  it('keeps the last known good catalog when refresh fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-catalog-'));
    let fail = false;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (fail) throw new Error('offline');
      return String(input).includes('openai.com')
        ? response({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] })
        : response({
            data: [
              {
                id: 'claude-opus-4-5-20251101',
                display_name: 'Claude Opus 4.5',
                created_at: '2025-11-01T00:00:00.000Z',
              },
            ],
            has_more: false,
          });
    });
    const service = new LlmCatalogService({
      dir,
      fetch: fetcher as typeof fetch,
      keyFor: () => 'key',
    });
    const before = await service.refresh();
    fail = true;
    const after = await service.refresh();
    expect(after.providers.map((provider) => provider.models)).toEqual(
      before.providers.map((provider) => provider.models),
    );
    expect(after.providers.every((provider) => provider.state === 'error')).toBe(true);
  });

  it('does not make a network request without keys and retains saved missing models', () => {
    const fetcher = vi.fn();
    const service = new LlmCatalogService({
      dir: mkdtempSync(join(tmpdir(), 'llm-catalog-')),
      fetch: fetcher as typeof fetch,
      keyFor: () => undefined,
      choices: () => [{ providerId: 'openai', modelId: 'saved-model' }],
    });
    const result = service.get();
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.providers.every((provider) => provider.state === 'missing-key')).toBe(true);
    expect(
      result.providers.find((provider) => provider.providerId === 'openai')?.models,
    ).toContainEqual(expect.objectContaining({ id: 'saved-model', status: 'unavailable' }));
  });
});
