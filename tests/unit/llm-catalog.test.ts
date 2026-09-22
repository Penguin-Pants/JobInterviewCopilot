import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRuntimeLlmModels, findLlmModel } from '../../src/shared/registry/llm.js';
import type { LlmCatalogResult, LlmModelDescriptor } from '../../src/shared/types.js';
import {
  CATALOG_MAX_AGE_MS,
  LlmCatalogService,
  anthropicCompatibility,
  openAiCompatibility,
} from '../../src/main/ai/llm/catalog.js';
import {
  llmCatalogStatus,
  modelsFromCutoff,
  normalizedCutoffs,
  withSelectedModel,
} from '../../src/renderer/dashboard/sections/ProviderSetup.js';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('runtime LLM catalog', () => {
  afterEach(() => clearRuntimeLlmModels());
  it('uses conservative centralized compatibility rules', () => {
    expect(openAiCompatibility({ id: 'gpt-4o-mini' })).toBeNull();
    expect(openAiCompatibility({ id: 'gpt-5' })).toEqual({
      allowed: ['minimal', 'low', 'medium', 'high'],
      default: 'medium',
    });
    expect(openAiCompatibility({ id: 'gpt-5.4' })).toEqual({
      allowed: ['none', 'low', 'medium', 'high'],
      default: 'medium',
    });
    expect(openAiCompatibility({ id: 'gpt-5.4-mini' })).toEqual({
      allowed: ['none', 'low', 'medium', 'high'],
      default: 'medium',
    });
    expect(openAiCompatibility({ id: 'gpt-5.5-2026-09-15' })).toEqual({
      allowed: ['none', 'low', 'medium', 'high'],
      default: 'medium',
    });
    expect(openAiCompatibility({ id: 'gpt-5-chat-latest' })).toBeNull();
    expect(openAiCompatibility({ id: 'gpt-5.4-chat-latest' })).toBeNull();
    for (const id of ['gpt-6-luna', 'gpt-6-terra', 'gpt-6-sol', 'gpt-12-orbit']) {
      expect(openAiCompatibility({ id })).toEqual({
        allowed: ['none', 'low', 'medium', 'high'],
        default: 'medium',
      });
    }
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
    expect(openAiCompatibility({ id: 'gpt-99-new' })).toEqual({
      allowed: ['none', 'low', 'medium', 'high'],
      default: 'medium',
    });
    expect(openAiCompatibility({ id: 'gpt-5-codex' })).toBe(false);
    expect(openAiCompatibility({ id: 'gpt-5-pro' })).toBe(false);
    expect(openAiCompatibility({ id: 'gpt-5.4-pro' })).toBe(false);
    expect(anthropicCompatibility('claude-haiku-4-5-20251001')).toBe(false);
    expect(anthropicCompatibility('claude-sonnet-4-6')).toBe(false);
    expect(anthropicCompatibility('claude-opus-4-7')).toBe(false);
    expect(anthropicCompatibility('claude-opus-4-8')).toBeNull();
    expect(anthropicCompatibility('claude-opus-4.9-20270101')).toBeNull();
    expect(anthropicCompatibility('claude-sonnet-5-20270101')).toBeNull();
    expect(anthropicCompatibility('claude-sonnet-6-latest')).toBeNull();
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
                id: 'claude-opus-4-8',
                display_name: 'Claude Opus 4.8',
                created_at: '2026-02-05T00:00:00.000Z',
              },
            ],
            has_more: false,
          })
        : response({
            data: [
              {
                id: 'claude-sonnet-5-20260929',
                display_name: 'Claude Sonnet 5',
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
    ).toEqual(['claude-opus-4-8', 'claude-sonnet-5-20260929']);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(readFileSync(join(dir, 'llm-catalog.json'), 'utf8')).schemaVersion).toBe(2);
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
                id: 'claude-opus-4-8-20261101',
                display_name: 'Claude Opus 4.8',
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

  it('revalidates cached models against the current compatibility policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-catalog-'));
    writeFileSync(
      join(dir, 'llm-catalog.json'),
      JSON.stringify({
        schemaVersion: 2,
        providers: {
          anthropic: {
            lastSuccessfulRefresh: new Date().toISOString(),
            models: [
              {
                id: 'claude-sonnet-4-6',
                displayName: 'Claude Sonnet 4.6',
                providerId: 'anthropic',
                releasedAt: null,
                status: 'available',
                streamingText: true,
                effort: null,
                pricing: { known: false },
              },
            ],
          },
        },
      }),
    );

    const service = new LlmCatalogService({ dir, keyFor: () => undefined });

    expect(service.get().providers.find((provider) => provider.providerId === 'anthropic')).toEqual(
      expect.objectContaining({ state: 'missing-key' }),
    );
    expect(findLlmModel({ providerId: 'anthropic', modelId: 'claude-sonnet-4-6' })).toBeNull();
  });

  it('invalidates catalogs written before the compatibility policy expanded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-catalog-'));
    writeFileSync(
      join(dir, 'llm-catalog.json'),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          openai: {
            lastSuccessfulRefresh: new Date().toISOString(),
            models: [
              {
                id: 'gpt-4.1',
                displayName: 'gpt-4.1',
                providerId: 'openai',
                releasedAt: null,
                status: 'available',
                streamingText: true,
                effort: null,
                pricing: { known: false },
              },
            ],
          },
        },
      }),
    );

    const service = new LlmCatalogService({ dir, keyFor: () => undefined });
    const openai = service.get().providers.find((provider) => provider.providerId === 'openai');

    expect(openai?.lastSuccessfulRefresh).toBeNull();
    expect(openai?.models.some((model) => model.id === 'gpt-4.1')).toBe(false);
  });

  it('refreshes only providers with saved keys and does not report missing providers as errors', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      response({ object: 'list', data: [{ id: 'gpt-5.4-mini', object: 'model' }] }),
    );
    const service = new LlmCatalogService({
      dir: mkdtempSync(join(tmpdir(), 'llm-catalog-')),
      fetch: fetcher as typeof fetch,
      keyFor: (provider) => (provider === 'openai' ? 'open-key' : undefined),
    });

    const result = await service.refresh();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('api.openai.com');
    expect(result.providers.find((provider) => provider.providerId === 'openai')?.state).toBe(
      'ready',
    );
    expect(
      result.providers.find((provider) => provider.providerId === 'openai')?.models[0]?.id,
    ).toBe('gpt-5.4-mini');
    expect(result.providers.find((provider) => provider.providerId === 'anthropic')?.state).toBe(
      'missing-key',
    );
    expect(llmCatalogStatus(result.providers)).toBe('Models are up to date.');
  });

  it('refreshes Anthropic without contacting OpenAI when only the Anthropic key is saved', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      response({
        data: [
          {
            id: 'claude-sonnet-5-20260929',
            display_name: 'Claude Sonnet 5',
            created_at: '2026-02-05T00:00:00.000Z',
          },
        ],
        has_more: false,
      }),
    );
    const service = new LlmCatalogService({
      dir: mkdtempSync(join(tmpdir(), 'llm-catalog-')),
      fetch: fetcher as typeof fetch,
      keyFor: (provider) => (provider === 'anthropic' ? 'anthropic-key' : undefined),
    });

    const result = await service.refresh();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('api.anthropic.com');
    expect(result.providers.find((provider) => provider.providerId === 'openai')?.state).toBe(
      'missing-key',
    );
    expect(result.providers.find((provider) => provider.providerId === 'anthropic')?.state).toBe(
      'ready',
    );
    expect(llmCatalogStatus(result.providers)).toBe('Models are up to date.');
  });

  it('bounds requests and publishes completed lazy refreshes', async () => {
    const updated = vi.fn();
    const hangingFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const service = new LlmCatalogService({
      dir: mkdtempSync(join(tmpdir(), 'llm-catalog-')),
      fetch: hangingFetch as typeof fetch,
      keyFor: () => 'key',
      requestTimeoutMs: 5,
      onUpdated: updated,
    });
    await service.refresh();
    expect(updated).toHaveBeenCalledOnce();
    const pushed = updated.mock.calls[0]?.[0] as LlmCatalogResult;
    expect(pushed.providers.every((provider) => provider.state === 'error')).toBe(true);
  });

  it('keeps an active runtime allowlist while invalidating persistent account data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-catalog-'));
    const service = new LlmCatalogService({
      dir,
      fetch: (async (input: string | URL | Request) =>
        String(input).includes('openai.com')
          ? response({ object: 'list', data: [{ id: 'gpt-5-mini', object: 'model' }] })
          : response({
              data: [
                {
                  id: 'claude-sonnet-5-20260929',
                  display_name: 'Claude Sonnet 5',
                  created_at: '2026-02-05T00:00:00.000Z',
                },
              ],
              has_more: false,
            })) as typeof fetch,
      keyFor: () => 'key',
    });
    await service.refresh();
    service.invalidate('openai');
    expect(findLlmModel({ providerId: 'openai', modelId: 'gpt-5-mini' })).not.toBeNull();
    expect(
      JSON.parse(readFileSync(join(dir, 'llm-catalog.json'), 'utf8')).providers.openai,
    ).toBeUndefined();
  });
});

describe('model display cutoff', () => {
  const models = ['gpt-5.4', 'gpt-5.3', 'gpt-5.2', 'gpt-5.1'].map((id) => ({
    id,
    displayName: id,
    providerId: 'openai' as const,
    releasedAt: null,
    status: 'available' as const,
    streamingText: true as const,
    effort: null,
    pricing: { known: false as const },
  }));

  it('shows the chosen model and every newer model', () => {
    expect(modelsFromCutoff(models, 'gpt-5.2').map((model) => model.id)).toEqual([
      'gpt-5.4',
      'gpt-5.3',
      'gpt-5.2',
    ]);
  });

  it('shows everything when no cutoff is saved or an old cutoff disappears', () => {
    expect(modelsFromCutoff(models, null)).toEqual(models);
    expect(modelsFromCutoff(models, 'retired-model')).toEqual(models);
  });

  it('keeps the saved model visible when the cutoff hides it', () => {
    const visible = modelsFromCutoff(models, 'gpt-5.3');
    expect(withSelectedModel(visible, models, 'gpt-5.1').map((model) => model.id)).toEqual([
      'gpt-5.1',
      'gpt-5.4',
      'gpt-5.3',
    ]);
  });

  it('keeps a retired model visible when the catalog appends it past the cutoff', () => {
    const retired: LlmModelDescriptor = {
      id: 'gpt-5.0',
      displayName: 'gpt-5.0',
      providerId: 'openai',
      releasedAt: null,
      status: 'unavailable',
      streamingText: true,
      effort: null,
      pricing: { known: false },
    };
    const all = [...models, retired];
    const visible = modelsFromCutoff(all, 'gpt-5.2');
    expect(visible.map((model) => model.id)).not.toContain('gpt-5.0');
    expect(withSelectedModel(visible, all, 'gpt-5.0')[0]).toEqual(retired);
  });

  it('drops a cutoff the catalog no longer lists, so the setting matches what is applied', () => {
    const providers = [
      {
        providerId: 'openai' as const,
        displayName: 'OpenAI',
        models,
        lastSuccessfulRefresh: null,
        state: 'ready' as const,
      },
    ];
    expect(normalizedCutoffs({ openai: 'retired-model', anthropic: null }, providers)).toEqual({
      openai: null,
      anthropic: null,
    });
  });

  it('returns the saved cutoffs unchanged when every one is still listed', () => {
    const providers = [
      {
        providerId: 'openai' as const,
        displayName: 'OpenAI',
        models,
        lastSuccessfulRefresh: null,
        state: 'ready' as const,
      },
    ];
    const cutoffs = { openai: 'gpt-5.2', anthropic: null };
    expect(normalizedCutoffs(cutoffs, providers)).toBe(cutoffs);
  });

  it('leaves the list alone when nothing is selected or the model is already shown', () => {
    const visible = modelsFromCutoff(models, 'gpt-5.3');
    expect(withSelectedModel(visible, models, null)).toEqual(visible);
    expect(withSelectedModel(visible, models, 'gpt-5.4')).toEqual(visible);
    expect(withSelectedModel(visible, models, 'never-existed')).toEqual(visible);
  });
});
