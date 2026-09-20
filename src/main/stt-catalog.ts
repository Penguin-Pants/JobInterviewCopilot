import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { STT_REGISTRY } from '../shared/registry/stt.js';
import type {
  CredentialId,
  SttCatalogProvider,
  SttCatalogSnapshot,
  SttModelDescriptor,
} from '../shared/types.js';

export const STT_CATALOG_MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000;
export const STT_CATALOG_REQUEST_TIMEOUT_MS = 10_000;
const PROVIDERS = ['openai', 'deepgram', 'elevenlabs'] as const;
type SttProviderId = (typeof PROVIDERS)[number];

const modelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  streaming: z.boolean(),
  supportsInterim: z.boolean(),
  supportsEndpointing: z.boolean(),
  supportsConfidence: z.boolean(),
  batchIntervalMs: z.number().positive().optional(),
  audio: z.object({
    encoding: z.literal('linear16'),
    sampleRate: z.literal(16000),
    channels: z.literal(1),
  }),
  pricePerAudioMinuteUsd: z.number().nonnegative(),
  providerId: z.string().optional(),
  providerDisplayName: z.string().optional(),
  releasedAt: z.string().optional(),
  catalogStatus: z.enum(['available', 'legacy', 'unavailable']).optional(),
  catalogSource: z.enum(['account', 'fallback']).optional(),
  priceKnown: z.boolean().optional(),
  badge: z.string().optional(),
});
const cacheSchema = z.object({
  schemaVersion: z.literal(1),
  providers: z.record(
    z.string(),
    z.object({
      refreshedAt: z.string().datetime(),
      credentialVersion: z.string().uuid().optional(),
      models: z.array(modelSchema).min(1),
    }),
  ),
});
type Cache = z.infer<typeof cacheSchema>;

export type CatalogFetch = typeof fetch;
export interface SttCatalogOptions {
  dir: string;
  keyFor: (id: CredentialId) => string | undefined;
  credentialVersionFor?: (id: CredentialId) => string | undefined;
  fetch?: CatalogFetch;
  now?: () => number;
}

/** Central conservative compatibility policy for metadata provider APIs omit. */
export function compatibleModel(providerId: SttProviderId, id: string): SttModelDescriptor | null {
  const shipped = STT_REGISTRY.find((p) => p.id === providerId)?.models.find((m) => m.id === id);
  return shipped ? { ...shipped, audio: { ...shipped.audio } } : null;
}

export function sortCatalogModels(models: SttModelDescriptor[]): SttModelDescriptor[] {
  const rank = { available: 0, legacy: 1, unavailable: 2 } as const;
  return [...models].sort(
    (a, b) =>
      rank[a.catalogStatus ?? 'available'] - rank[b.catalogStatus ?? 'available'] ||
      (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '') ||
      a.displayName.localeCompare(b.displayName) ||
      a.id.localeCompare(b.id),
  );
}

function fallback(providerId: SttProviderId): SttModelDescriptor[] {
  const provider = STT_REGISTRY.find((p) => p.id === providerId)!;
  return provider.models.map((m) => ({
    ...m,
    audio: { ...m.audio },
    providerId,
    providerDisplayName: provider.displayName,
    catalogStatus: 'available',
    catalogSource: 'fallback',
    priceKnown: true,
  }));
}

export class SttCatalogService {
  private readonly file: string;
  private readonly fetcher: CatalogFetch;
  private readonly now: () => number;
  private cache: Cache;
  private readonly generations = new Map<SttProviderId, number>();
  constructor(private readonly options: SttCatalogOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.file = join(options.dir, 'stt-catalog.json');
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.cache = this.read();
  }
  private read(): Cache {
    if (!existsSync(this.file)) return { schemaVersion: 1, providers: {} };
    try {
      const parsed = cacheSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      for (const providerId of PROVIDERS) {
        const entry = parsed.providers[providerId];
        if (!entry) continue;
        const models = entry.models.flatMap((cached) => {
          const current = compatibleModel(providerId, cached.id);
          return current
            ? [
                {
                  ...current,
                  providerId,
                  releasedAt: cached.releasedAt,
                  catalogStatus: 'available' as const,
                  catalogSource: 'account' as const,
                  priceKnown: true,
                },
              ]
            : [];
        });
        if (models.length === 0) delete parsed.providers[providerId];
        else entry.models = sortCatalogModels(models);
      }
      return parsed;
    } catch {
      return { schemaVersion: 1, providers: {} };
    }
  }
  private persist(cache: Cache): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2));
    renameSync(tmp, this.file);
  }
  invalidate(credentialId: CredentialId): void {
    if (!PROVIDERS.includes(credentialId as SttProviderId)) return;
    const providerId = credentialId as SttProviderId;
    this.generations.set(providerId, (this.generations.get(providerId) ?? 0) + 1);
    const next = structuredClone(this.cache);
    delete next.providers[providerId];
    this.cache = next;
    this.persist(next);
  }
  async get(force = false): Promise<SttCatalogSnapshot> {
    const providers = await Promise.all(PROVIDERS.map((id) => this.one(id, force)));
    return { providers };
  }
  private async one(providerId: SttProviderId, force: boolean): Promise<SttCatalogProvider> {
    const descriptor = STT_REGISTRY.find((p) => p.id === providerId)!;
    const cached = this.cache.providers[providerId];
    const key = this.options.keyFor(descriptor.credentialId);
    if (!key) return this.result(providerId, cached, 'missing-key', 'No API key is saved.');
    if (providerId !== 'openai') {
      return this.result(
        providerId,
        undefined,
        'fallback',
        'This provider does not expose a safe account-availability catalog for this realtime path.',
      );
    }
    const credentialVersion = this.options.credentialVersionFor?.(descriptor.credentialId);
    const versionMatches = cached?.credentialVersion === credentialVersion;
    const age = cached ? this.now() - Date.parse(cached.refreshedAt) : Number.POSITIVE_INFINITY;
    const fresh = cached && versionMatches && age >= 0 && age < STT_CATALOG_MAX_AGE_MS;
    if (fresh && !force) return this.result(providerId, cached, 'ready');
    try {
      const generation = this.generations.get(providerId) ?? 0;
      const models = await this.discover(providerId, key);
      if ((this.generations.get(providerId) ?? 0) !== generation) {
        return this.result(
          providerId,
          this.cache.providers[providerId],
          'stale',
          'The credential changed during refresh. Refresh again to use the saved key.',
        );
      }
      if (models.length === 0)
        throw new Error('No compatible speech-to-text models were returned.');
      const next = {
        refreshedAt: new Date(this.now()).toISOString(),
        ...(credentialVersion ? { credentialVersion } : {}),
        models: sortCatalogModels(models),
      };
      // Do not publish the replacement in memory until the atomic disk write
      // succeeds. A full disk must leave both copies on the last-known-good
      // value rather than serving a result that will disappear on restart.
      const nextCache = structuredClone(this.cache);
      nextCache.providers[providerId] = next;
      this.persist(nextCache);
      this.cache = nextCache;
      return this.result(providerId, next, 'ready');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model discovery failed.';
      const current = this.cache.providers[providerId];
      const currentVersion = this.options.credentialVersionFor?.(descriptor.credentialId);
      const usable = current?.credentialVersion === currentVersion ? current : undefined;
      return this.result(providerId, usable, usable ? 'stale' : 'fallback', message);
    }
  }
  private result(
    providerId: SttProviderId,
    cached: Cache['providers'][string] | undefined,
    state: SttCatalogProvider['state'],
    message?: string,
  ): SttCatalogProvider {
    const p = STT_REGISTRY.find((entry) => entry.id === providerId)!;
    return {
      providerId,
      displayName: p.displayName,
      source: cached ? 'account' : 'fallback',
      state,
      lastSuccessfulRefresh: cached?.refreshedAt ?? null,
      models: cached?.models ?? fallback(providerId),
      ...(message ? { message } : {}),
    };
  }
  private async discover(providerId: SttProviderId, key: string): Promise<SttModelDescriptor[]> {
    // Deepgram has project-scoped model metadata, but it is not an account-entitlement list.
    // ElevenLabs' general models endpoint does not identify realtime STT capability. Returning
    // shipped policy is safer than guessing from names and is explicitly labelled fallback.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STT_CATALOG_REQUEST_TIMEOUT_MS);
    let body: unknown;
    try {
      const response = await this.fetcher('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenAI model discovery failed (${response.status}).`);
      body = await response.json();
    } finally {
      clearTimeout(timeout);
    }
    const parsed = z
      .object({ data: z.array(z.object({ id: z.string(), created: z.number().optional() })) })
      .safeParse(body);
    if (!parsed.success) throw new Error('OpenAI returned a malformed model catalog.');
    return parsed.data.data.flatMap((item) => {
      const known = compatibleModel('openai', item.id);
      if (!known) return [];
      return [
        {
          ...known,
          providerId,
          ...(item.created ? { releasedAt: new Date(item.created * 1000).toISOString() } : {}),
          catalogStatus: 'available' as const,
          catalogSource: 'account' as const,
          priceKnown: true,
        },
      ];
    });
  }
}
