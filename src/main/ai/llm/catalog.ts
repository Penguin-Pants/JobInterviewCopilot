import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  LlmCatalogProvider,
  LlmCatalogResult,
  LlmModelDescriptor,
  ProviderChoice,
} from '../../../shared/types.js';
import { LLM_REGISTRY, registerRuntimeLlmModels } from '../../../shared/registry/llm.js';
import { PRICE_TABLE } from '../../cost.js';

export const CATALOG_MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000;
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
const ANTHROPIC_VERSION = '2023-06-01';

type CatalogProviderId = 'openai' | 'anthropic';

const modelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  providerId: z.enum(['openai', 'anthropic']),
  releasedAt: z.string().nullable(),
  status: z.enum(['available', 'legacy', 'unavailable']),
  streamingText: z.literal(true),
  effort: z.object({ allowed: z.array(z.string()).min(1), default: z.string() }).nullable(),
  pricing: z.discriminatedUnion('known', [
    z.object({ known: z.literal(true), inputPerMTokUsd: z.number(), outputPerMTokUsd: z.number() }),
    z.object({ known: z.literal(false) }),
  ]),
});
const cacheSchema = z.object({
  schemaVersion: z.literal(1),
  providers: z.object({
    openai: z
      .object({ models: z.array(modelSchema).min(1), lastSuccessfulRefresh: z.string().datetime() })
      .optional(),
    anthropic: z
      .object({ models: z.array(modelSchema).min(1), lastSuccessfulRefresh: z.string().datetime() })
      .optional(),
  }),
});
interface Cache {
  schemaVersion: 1;
  providers: Partial<
    Record<CatalogProviderId, { models: LlmModelDescriptor[]; lastSuccessfulRefresh: string }>
  >;
}

interface OpenAiModel {
  id: string;
  created?: number;
  owned_by?: string;
}
const openAiResponse = z.object({
  object: z.literal('list'),
  data: z.array(
    z.object({
      id: z.string().min(1),
      object: z.literal('model').optional(),
      created: z.number().optional(),
      owned_by: z.string().optional(),
    }),
  ),
});
const anthropicResponse = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().min(1),
      created_at: z.string().datetime(),
      type: z.literal('model').optional(),
    }),
  ),
  has_more: z.boolean(),
  first_id: z.string().nullable().optional(),
  last_id: z.string().nullable().optional(),
});

/** Models endpoints do not publish capabilities; this is the single conservative policy. */
export function openAiCompatibility(model: OpenAiModel): LlmModelDescriptor['effort'] | false {
  const id = model.id.toLowerCase();
  if (id.includes(':') || id.startsWith('ft:')) return false;
  if (
    /(audio|transcri|whis\x70er|tts|speech|realtime|image|dall-e|embedding|moderation|search|instruct|preview)/u.test(
      id,
    )
  )
    return false;
  if (/^gpt-5(?:[.-]|$)/u.test(id))
    return { allowed: ['minimal', 'low', 'medium', 'high'], default: 'medium' };
  if (/^gpt-(?:4o|4\.1)(?:[.-]|$)/u.test(id)) return null;
  return false;
}

export function anthropicCompatibility(id: string): LlmModelDescriptor['effort'] | false {
  const lower = id.toLowerCase();
  if (!lower.startsWith('claude-') || lower.includes('haiku')) return false;
  if (!/(?:sonnet|opus)/u.test(lower)) return false;
  if (/claude-opus-4-6/u.test(lower))
    return { allowed: ['low', 'medium', 'high', 'max'], default: 'high' };
  if (/claude-sonnet-4-6/u.test(lower))
    return { allowed: ['low', 'medium', 'high'], default: 'high' };
  if (/claude-(?:sonnet|opus)-4-(?:[0-5])(?:-|$)/u.test(lower)) return null;
  return false;
}

function pricing(providerId: CatalogProviderId, id: string): LlmModelDescriptor['pricing'] {
  const row = PRICE_TABLE.llm[`${providerId}:${id}`];
  return row
    ? { known: true, inputPerMTokUsd: row.inputPerMTok, outputPerMTokUsd: row.outputPerMTok }
    : { known: false };
}

function sortModels(models: LlmModelDescriptor[]): LlmModelDescriptor[] {
  return models.sort(
    (a, b) =>
      (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '') ||
      a.displayName.localeCompare(b.displayName) ||
      a.id.localeCompare(b.id),
  );
}

export interface LlmCatalogOptions {
  dir: string;
  keyFor: (provider: CatalogProviderId) => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (message: string, detail?: unknown) => void;
  choices?: () => (ProviderChoice | null)[];
}

export class LlmCatalogService {
  private readonly file: string;
  private cache: Cache;
  private refreshing: Promise<void> | null = null;
  private readonly errors = new Map<CatalogProviderId, string>();
  constructor(private readonly options: LlmCatalogOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.file = join(options.dir, 'llm-catalog.json');
    this.cache = this.read();
    this.register();
  }

  invalidate(provider: string): void {
    if (provider !== 'openai' && provider !== 'anthropic') return;
    delete this.cache.providers[provider];
    this.write();
    registerRuntimeLlmModels(provider, []);
  }

  get(): LlmCatalogResult {
    const stale = (['openai', 'anthropic'] as const).some(
      (p) => this.isStale(p) && this.options.keyFor(p),
    );
    if (stale && !this.refreshing) {
      this.refreshing = this.refreshAll().finally(() => {
        this.refreshing = null;
      });
    }
    return this.result();
  }

  async refresh(): Promise<LlmCatalogResult> {
    if (!this.refreshing)
      this.refreshing = this.refreshAll().finally(() => {
        this.refreshing = null;
      });
    await this.refreshing;
    return this.result();
  }

  private isStale(provider: CatalogProviderId): boolean {
    const stamp = this.cache.providers[provider]?.lastSuccessfulRefresh;
    return !stamp || (this.options.now?.() ?? Date.now()) - Date.parse(stamp) >= CATALOG_MAX_AGE_MS;
  }

  private async refreshAll(): Promise<void> {
    await Promise.all(
      (['openai', 'anthropic'] as const).map(async (provider) => {
        const key = this.options.keyFor(provider);
        if (!key) return;
        try {
          const models =
            provider === 'openai'
              ? await this.discoverOpenAi(key)
              : await this.discoverAnthropic(key);
          if (models.length === 0) throw new Error('Provider returned no compatible models.');
          this.cache.providers[provider] = {
            models,
            lastSuccessfulRefresh: new Date(this.options.now?.() ?? Date.now()).toISOString(),
          };
          this.errors.delete(provider);
          this.write();
          registerRuntimeLlmModels(provider, models);
        } catch (err) {
          this.errors.set(provider, 'Refresh failed; the last known-good models were kept.');
          this.options.onError?.(`could not refresh the ${provider} model catalog`, err);
        }
      }),
    );
  }

  private async discoverOpenAi(key: string): Promise<LlmModelDescriptor[]> {
    const response = await (this.options.fetch ?? fetch)(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) throw new Error(`OpenAI models request returned ${response.status}.`);
    const parsed = openAiResponse.parse(await response.json());
    return sortModels(
      parsed.data.flatMap((model) => {
        const effort = openAiCompatibility(model);
        if (effort === false) return [];
        return [
          {
            id: model.id,
            displayName: model.id,
            providerId: 'openai' as const,
            releasedAt: model.created ? new Date(model.created * 1000).toISOString() : null,
            status: 'available' as const,
            streamingText: true as const,
            effort,
            pricing: pricing('openai', model.id),
          },
        ];
      }),
    );
  }

  private async discoverAnthropic(key: string): Promise<LlmModelDescriptor[]> {
    const models: z.infer<typeof anthropicResponse>['data'] = [];
    let url = ANTHROPIC_MODELS_URL;
    let hasMore = true;
    while (hasMore) {
      const response = await (this.options.fetch ?? fetch)(url, {
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      });
      if (!response.ok) throw new Error(`Anthropic models request returned ${response.status}.`);
      const page = anthropicResponse.parse(await response.json());
      models.push(...page.data);
      hasMore = page.has_more;
      if (!hasMore) break;
      if (!page.last_id) throw new Error('Anthropic pagination omitted last_id.');
      url = `${ANTHROPIC_MODELS_URL}&after_id=${encodeURIComponent(page.last_id)}`;
    }
    return sortModels(
      models.flatMap((model) => {
        const effort = anthropicCompatibility(model.id);
        if (effort === false) return [];
        return [
          {
            id: model.id,
            displayName: model.display_name,
            providerId: 'anthropic' as const,
            releasedAt: model.created_at,
            status: 'available' as const,
            streamingText: true as const,
            effort,
            pricing: pricing('anthropic', model.id),
          },
        ];
      }),
    );
  }

  private result(): LlmCatalogResult {
    const selected = this.options.choices?.() ?? [];
    return {
      providers: LLM_REGISTRY.map((provider) => {
        const id = provider.id as CatalogProviderId;
        const saved = this.cache.providers[id];
        let models = saved?.models.map((m) => ({ ...m })) ?? provider.models.map((m) => ({ ...m }));
        for (const choice of selected.filter((c) => c?.providerId === id)) {
          if (choice && !models.some((m) => m.id === choice.modelId))
            models.push({
              id: choice.modelId,
              displayName: choice.modelId,
              providerId: id,
              releasedAt: null,
              status: 'unavailable',
              streamingText: true,
              effort: null,
              pricing: pricing(id, choice.modelId),
            });
        }
        return {
          providerId: id,
          displayName: provider.displayName,
          models,
          lastSuccessfulRefresh: saved?.lastSuccessfulRefresh ?? null,
          state: !this.options.keyFor(id)
            ? 'missing-key'
            : this.errors.has(id)
              ? 'error'
              : saved
                ? 'ready'
                : 'fallback',
          ...(!this.options.keyFor(id)
            ? { message: 'No API key is saved.' }
            : this.errors.has(id)
              ? { message: this.errors.get(id) }
              : {}),
        } as LlmCatalogProvider;
      }),
    };
  }

  private read(): Cache {
    if (!existsSync(this.file)) return { schemaVersion: 1, providers: {} };
    try {
      return cacheSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) as Cache;
    } catch (err) {
      this.options.onError?.('ignored an invalid LLM catalog cache', err);
      return { schemaVersion: 1, providers: {} };
    }
  }
  private write(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.cache, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
  private register(): void {
    for (const provider of ['openai', 'anthropic'] as const) {
      const entry = this.cache.providers[provider];
      if (entry) registerRuntimeLlmModels(provider, entry.models);
    }
  }
}
